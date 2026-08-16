import os
import yaml
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
import zipfile
import io
import re

# ====================================================
#  CONFIGURACIÓN
# ====================================================
API_BASE = "https://ariedro.dev/api-trenes"
GTFS_CDN_URL = "https://cdn.buenosaires.gob.ar/datosabiertos/datasets/trenes-gtfs/trenes-gtfs.zip"
GTFS_OFICIAL_URL = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/f74dacd7-63df-4a56-80f5-b1f590c9199d"

# ====================================================
#  1. HELPERS
# ====================================================
def fetch_with_retries(url, params=None, retries=5, backoff=1.5, timeout=30):
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp
        except (requests.RequestException, ConnectionError) as e:
            wait = backoff ** attempt
            print(f"    Intento {attempt+1}/{retries} falló: {e}. Reintentando en {wait:.1f}s...")
            time.sleep(wait)
    raise Exception(f"Todos los {retries} reintentos fallaron para {url}")

def normalizar_nombre(nombre):
    """Normaliza nombres para comparación."""
    if not isinstance(nombre, str):
        return ""
    n = nombre.upper()
    n = n.replace('Á','A').replace('É','E').replace('Í','I').replace('Ó','O').replace('Ú','U')
    n = n.replace('Ñ','N')
    n = re.sub(r'\s+', ' ', n).strip()
    return n

# ====================================================
#  2. OBTENER HORARIOS DESDE API
# ====================================================
def fetch_from_api(origen, destino, fecha, hora_inicio, estaciones_ids, cantidad=60):
    """
    Obtiene horarios desde la API de Ariedro.
    estaciones_ids: lista de dict con 'nombre' e 'id' (id puede ser None)
    """
    # Filtrar estaciones con ID válido para la consulta
    estaciones_validas = [e for e in estaciones_ids if e['id'] is not None]
    if not estaciones_validas:
        raise ValueError("No hay estaciones con ID válido")

    # Buscar origen y destino en las válidas (si no están, falla)
    origen_id = None
    destino_id = None
    for est in estaciones_validas:
        if est['nombre'] == origen:
            origen_id = est['id']
        if est['nombre'] == destino:
            destino_id = est['id']
    if origen_id is None:
        # Si el origen no tiene ID, intentar con el primero de la lista (como fallback)
        origen_id = estaciones_validas[0]['id']
        print(f"    ⚠️ Origen '{origen}' sin ID, usando '{estaciones_validas[0]['nombre']}' como origen")
    if destino_id is None:
        # Si el destino no tiene ID, usar el último de la lista (como fallback)
        destino_id = estaciones_validas[-1]['id']
        print(f"    ⚠️ Destino '{destino}' sin ID, usando '{estaciones_validas[-1]['nombre']}' como destino")

    params = {
        "hasta": destino_id,
        "fecha": fecha,
        "hora": hora_inicio,
        "cantidad": cantidad
    }
    resp = fetch_with_retries(f"{API_BASE}/arribos/estacion/{origen_id}", params=params)
    data = resp.json()

    rows = []
    results = data.get("results", [])
    if not results:
        raise ValueError("La API no devolvió resultados")

    for item in results:
        servicio = item.get("servicio", {})
        trip_id = servicio.get("numero", "")
        if not trip_id:
            trip_id = f"serv_{hash(str(item))}"  # fallback

        # Obtener el recorrido de estaciones desde el servicio
        estaciones_recorrido = servicio.get("estaciones", [])
        if not estaciones_recorrido:
            # Si no viene el recorrido, usar el objeto 'arribo' como única estación
            arribo = item.get("arribo", {})
            nombre_est = arribo.get("nombre", "")
            if nombre_est:
                estaciones_recorrido = [arribo]
            else:
                continue

        # Crear mapa de nombres normalizados del recorrido real
        recorrido_map = {}
        for est in estaciones_recorrido:
            nombre = est.get("nombre", "")
            if nombre:
                recorrido_map[normalizar_nombre(nombre)] = est

        # Para cada estación de nuestro recorrido nominal, buscar su horario en el recorrido real
        for est_info in estaciones_ids:
            nombre_est = est_info['nombre']
            nombre_norm = normalizar_nombre(nombre_est)
            est_data = recorrido_map.get(nombre_norm)

            if est_data:
                salida = est_data.get("salida", {}).get("programada", "")
                llegada = est_data.get("llegada", {}).get("programada", "")
                # Extraer solo hora
                if salida:
                    try:
                        dt = datetime.fromisoformat(salida.replace('Z', '+00:00'))
                        hora_salida = dt.strftime("%H:%M")
                    except:
                        hora_salida = salida
                else:
                    hora_salida = ""
                if llegada:
                    try:
                        dt = datetime.fromisoformat(llegada.replace('Z', '+00:00'))
                        hora_llegada = dt.strftime("%H:%M")
                    except:
                        hora_llegada = llegada
                else:
                    hora_llegada = ""
                # Determinar tipo de parada
                if nombre_est == origen:
                    tipo = "origen"
                elif nombre_est == destino:
                    tipo = "destino"
                else:
                    tipo = "paso"
            else:
                # La estación no está en el recorrido real
                hora_salida = ""
                hora_llegada = ""
                tipo = "no_pasa"

            rows.append({
                'trip_id': trip_id,
                'estacion': nombre_est,
                'hora_salida': hora_salida,
                'hora_llegada': hora_llegada,
                'tipo_parada': tipo,
                'servicio': trip_id
            })

    if not rows:
        raise ValueError("No se encontraron servicios para el horario solicitado")

    df = pd.DataFrame(rows)
    # Ordenar por trip_id y luego por el orden de las estaciones en la lista
    estacion_orden = {e['nombre']: i for i, e in enumerate(estaciones_ids)}
    df['orden'] = df['estacion'].map(estacion_orden)
    df = df.sort_values(['trip_id', 'orden']).drop(columns=['orden'])
    return df

# ====================================================
#  3. FALLBACK: GTFS
# ====================================================
def fetch_from_gtfs(origen, destino, tipo_dia, estaciones_ids):
    """Fallback usando GTFS para estaciones que no tienen ID o cuando la API falla."""
    try:
        # Intentar descargar desde CDN
        resp = fetch_with_retries(GTFS_CDN_URL, retries=3)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            with z.open("stops.txt") as f:
                stops_df = pd.read_csv(f)
            with z.open("stop_times.txt") as f:
                stop_times_df = pd.read_csv(f)
            with z.open("trips.txt") as f:
                trips_df = pd.read_csv(f)
            # calendar.txt opcional
            try:
                with z.open("calendar.txt") as f:
                    calendar_df = pd.read_csv(f)
            except:
                calendar_df = None

        # Normalizar nombres en GTFS
        stops_df['stop_name_norm'] = stops_df['stop_name'].apply(normalizar_nombre)

        # Obtener nombres de estaciones
        estaciones_nombres = [e['nombre'] for e in estaciones_ids]
        stop_ids = []
        for nombre in estaciones_nombres:
            nombre_norm = normalizar_nombre(nombre)
            match = stops_df[stops_df['stop_name_norm'].str.contains(nombre_norm, na=False)]
            if not match.empty:
                stop_ids.append(match.iloc[0]['stop_id'])
            else:
                stop_ids.append(None)

        # Obtener origen y destino (primer y último con ID)
        origen_id = None
        destino_id = None
        for i, sid in enumerate(stop_ids):
            if sid is not None and origen_id is None:
                origen_id = sid
            if sid is not None:
                destino_id = sid  # el último con ID

        if origen_id is None or destino_id is None:
            raise ValueError("No se encontraron origen o destino en GTFS")

        # Obtener viajes comunes
        stop_times_origen = stop_times_df[stop_times_df['stop_id'] == origen_id]
        stop_times_destino = stop_times_df[stop_times_df['stop_id'] == destino_id]
        trip_ids_origen = set(stop_times_origen['trip_id'].unique())
        trip_ids_destino = set(stop_times_destino['trip_id'].unique())
        trip_ids_comunes = trip_ids_origen.intersection(trip_ids_destino)

        if not trip_ids_comunes:
            raise ValueError("No hay viajes que conecten origen y destino")

        # Filtrar por tipo de día si calendar_df existe
        if calendar_df is not None:
            dias_map = {
                'Lunes-Viernes': [0,1,2,3,4],
                'Sabado': [5],
                'Domingo': [6],
                'Domingo-Feriado': [6],
                'Feriados': [],
                'NoLaboral': [6]
            }
            dias_semana = dias_map.get(tipo_dia, [])
            if dias_semana:
                dias_nombres = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
                service_ids_validos = []
                for _, row in calendar_df.iterrows():
                    for dia in dias_semana:
                        if dia < len(dias_nombres) and row[dias_nombres[dia]] == 1:
                            service_ids_validos.append(row['service_id'])
                            break
                if service_ids_validos:
                    trips_df = trips_df[trips_df['service_id'].isin(service_ids_validos)]
                    trip_ids_comunes = trip_ids_comunes.intersection(set(trips_df['trip_id'].unique()))

        if not trip_ids_comunes:
            raise ValueError("No hay viajes para el tipo de día solicitado")

        # Construir el DataFrame
        rows = []
        for trip_id in trip_ids_comunes:
            trip_stop_times = stop_times_df[stop_times_df['trip_id'] == trip_id]
            for i, stop_id in enumerate(stop_ids):
                if stop_id is None:
                    continue
                st = trip_stop_times[trip_stop_times['stop_id'] == stop_id]
                if not st.empty:
                    hora_salida = st.iloc[0]['departure_time']
                    hora_llegada = st.iloc[0]['arrival_time']
                    tipo = "origen" if i == 0 else "destino" if i == len(stop_ids)-1 else "paso"
                    rows.append({
                        'trip_id': trip_id,
                        'estacion': estaciones_nombres[i],
                        'hora_salida': hora_salida,
                        'hora_llegada': hora_llegada,
                        'tipo_parada': tipo,
                        'servicio': trip_id
                    })
        if not rows:
            raise ValueError("No se encontraron horarios en GTFS")
        df = pd.DataFrame(rows)
        estacion_orden = {e['nombre']: i for i, e in enumerate(estaciones_ids)}
        df['orden'] = df['estacion'].map(estacion_orden)
        df = df.sort_values(['trip_id', 'orden']).drop(columns=['orden'])
        return df
    except Exception as e:
        print(f"    GTFS falló: {e}")
        raise

# ====================================================
#  4. ORQUESTADOR
# ====================================================
def obtener_fecha_para_tipo(tipo_dia):
    hoy = datetime.now()
    if tipo_dia == "Lunes-Viernes":
        days_until = (7 - hoy.weekday()) % 7
        if days_until == 0:
            days_until = 7
        return (hoy + timedelta(days=days_until)).strftime("%Y-%m-%d")
    elif tipo_dia in ["Sabado", "Sabado-Domingo-Feriados"]:
        days_until = (5 - hoy.weekday()) % 7
        if days_until == 0:
            days_until = 7
        return (hoy + timedelta(days=days_until)).strftime("%Y-%m-%d")
    elif tipo_dia in ["Domingo", "NoLaboral", "Domingo-Feriado"]:
        days_until = (6 - hoy.weekday()) % 7
        if days_until == 0:
            days_until = 7
        return (hoy + timedelta(days=days_until)).strftime("%Y-%m-%d")
    else:  # Feriados
        return hoy.strftime("%Y-%m-%d")

def get_trenes(origen, destino, tipo_dia, estaciones_ids):
    """Obtiene horarios usando API con fallback a GTFS."""
    fecha = obtener_fecha_para_tipo(tipo_dia)

    # Método 1: API
    try:
        print("  Intentando método: API SOFSE")
        df = fetch_from_api(origen, destino, fecha, "00:00", estaciones_ids, 60)
        if not df.empty:
            print("  ✅ Método 'API SOFSE' exitoso")
            # Si hay estaciones con ID None que no aparecen en la API, intentamos completar con GTFS
            # (para Lozano, por ejemplo)
            # Pero por ahora devolvemos lo que tenemos
            return df
    except Exception as e:
        print(f"  ❌ Método 'API SOFSE' falló: {e}")

    # Método 2: GTFS
    try:
        print("  Intentando método: GTFS")
        df = fetch_from_gtfs(origen, destino, tipo_dia, estaciones_ids)
        if not df.empty:
            print("  ✅ Método 'GTFS' exitoso")
            return df
    except Exception as e:
        print(f"  ❌ Método 'GTFS' falló: {e}")

    print(f"  ⚠️ Todos los métodos fallaron para {origen}->{destino} ({tipo_dia})")
    return pd.DataFrame()

# ====================================================
#  5. GUARDAR CSV
# ====================================================
def guardar_si_cambia(df, ruta):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    if os.path.exists(ruta):
        old_df = pd.read_csv(ruta)
        if df.equals(old_df):
            print(f"  Sin cambios en {ruta}")
            return False
    df.to_csv(ruta, index=False)
    print(f"  ✅ Actualizado {ruta}")
    return True

# ====================================================
#  6. MAIN
# ====================================================
def main():
    # Cargar configuraciones
    with open("config/routes.yaml", "r") as f:
        routes = yaml.safe_load(f)

    with open("config/station_ids.yaml", "r") as f:
        ids_config = yaml.safe_load(f)

    cambios = False

    for ruta in routes["trenes"]:
        origen = ruta["origen"]
        destino = ruta["destino"]
        carpeta = ruta["carpeta"]
        ramal_key = ruta.get("ramal_key")
        if not ramal_key:
            print(f"⚠️ Falta ramal_key para {ruta['nombre']}")
            continue

        estaciones_ids = ids_config["estaciones"].get(ramal_key, [])
        if not estaciones_ids:
            print(f"⚠️ No hay IDs para el ramal {ramal_key}")
            continue

        print(f"\n📌 Procesando: {origen} -> {destino}")
        print(f"   Estaciones: {', '.join([e['nombre'] for e in estaciones_ids])}")

        for tipo in ruta["tipos_dia"]:
            print(f"  📅 Tipo: {tipo}")

            # Ida
            print(f"    🚉 Ida: {origen} -> {destino}")
            df_ida = get_trenes(origen, destino, tipo, estaciones_ids)
            if not df_ida.empty:
                archivo = f"{origen}-{destino}-{tipo}.csv"
                ruta_archivo = os.path.join(carpeta, archivo)
                if guardar_si_cambia(df_ida, ruta_archivo):
                    cambios = True
            else:
                print(f"    ⚠️ No se obtuvieron datos para la ida")

            # Vuelta: invertir el orden de las estaciones y cambiar origen/destino
            estaciones_vuelta_ids = list(reversed(estaciones_ids))
            print(f"    🚉 Vuelta: {destino} -> {origen}")
            df_vuelta = get_trenes(destino, origen, tipo, estaciones_vuelta_ids)
            if not df_vuelta.empty:
                archivo = f"{destino}-{origen}-{tipo}.csv"
                ruta_archivo = os.path.join(carpeta, archivo)
                if guardar_si_cambia(df_vuelta, ruta_archivo):
                    cambios = True
            else:
                print(f"    ⚠️ No se obtuvieron datos para la vuelta")

    return 0 if cambios else 1

if __name__ == "__main__":
    main()