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
#  1. HELPER DE REINTENTOS (5 intentos con backoff)
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

# ====================================================
#  2. OBTENER ID DE ESTACIÓN (usando id_estacion)
# ====================================================
def get_station_id(station_name):
    """Busca el ID de una estación por nombre usando la API."""
    resp = fetch_with_retries(f"{API_BASE}/infraestructura/estaciones", params={"nombre": station_name})
    data = resp.json()
    if not data:
        raise ValueError(f"No se encontró la estación: {station_name}")
    
    # Buscar coincidencia exacta (case insensitive)
    for estacion in data:
        if estacion.get("nombre", "").lower() == station_name.lower():
            return int(estacion["id_estacion"])  # ← CLAVE CORRECTA: id_estacion
    
    # Si no hay coincidencia exacta, usar el primero
    return int(data[0]["id_estacion"])  # ← CLAVE CORRECTA: id_estacion

# ====================================================
#  3. OBTENER HORARIOS DESDE API (método principal)
# ====================================================
def fetch_from_api(origen, destino, fecha, hora_inicio, cantidad=50):
    """Obtiene horarios desde la API de SOFSE (vía proxy Ariedro)."""
    origen_id = get_station_id(origen)
    destino_id = get_station_id(destino)
    
    params = {
        "hasta": destino_id,
        "fecha": fecha,
        "hora": hora_inicio,
        "cantidad": cantidad
    }
    resp = fetch_with_retries(f"{API_BASE}/arribos/estacion/{origen_id}", params=params)
    data = resp.json()
    
    rows = []
    # La respuesta es un objeto con "results" que contiene los arribos
    results = data.get("results", [])
    for item in results:
        arribo = item.get("arribo", {})
        servicio = item.get("servicio", {})
        
        # Extraer hora de salida programada
        salida_programada = arribo.get("salida", {}).get("programada", "")
        if salida_programada:
            # Formato ISO: "2026-08-16T15:44:00.000Z" → extraer solo hora
            try:
                dt = datetime.fromisoformat(salida_programada.replace('Z', '+00:00'))
                hora_salida = dt.strftime("%H:%M")
            except:
                hora_salida = salida_programada
        else:
            hora_salida = ""
        
        rows.append({
            "origen": origen,
            "destino": destino,
            "hora_salida": hora_salida,
            "fecha": fecha,
            "servicio": servicio.get("numero", ""),
            "tipo": servicio.get("tipo", {}).get("nombre", ""),
            "ramal": servicio.get("ramal", {}).get("nombre", ""),
            "sentido": servicio.get("sentido", ""),
            "equipo": servicio.get("equipo", {}).get("nombre", "")
        })
    
    if not rows:
        raise ValueError("No se encontraron servicios para el horario solicitado")
    
    return pd.DataFrame(rows).sort_values("hora_salida")

# ====================================================
#  4. FALLBACK: GTFS (por si la API falla)
# ====================================================
def fetch_from_gtfs(origen, destino, tipo_dia):
    """Descarga y procesa el feed GTFS como fallback."""
    def normalizar(n):
        n = n.upper()
        n = n.replace('Á','A').replace('É','E').replace('Í','I').replace('Ó','O').replace('Ú','U')
        n = re.sub(r'\s+', ' ', n).strip()
        return n
    
    try:
        # Intentar primero con CDN, luego con oficial
        urls = [GTFS_CDN_URL, GTFS_OFICIAL_URL]
        stops_df = None
        stop_times_df = None
        trips_df = None
        
        for url in urls:
            try:
                print(f"    Descargando GTFS desde: {url}")
                resp = fetch_with_retries(url, retries=2)
                with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
                    with z.open("stops.txt") as f:
                        stops_df = pd.read_csv(f)
                    with z.open("stop_times.txt") as f:
                        stop_times_df = pd.read_csv(f)
                    with z.open("trips.txt") as f:
                        trips_df = pd.read_csv(f)
                break
            except Exception as e:
                print(f"    Falló descarga desde {url}: {e}")
                continue
        
        if stops_df is None:
            raise ValueError("No se pudo descargar el GTFS desde ninguna fuente")
        
        # Normalizar nombres de estaciones
        stops_df['stop_name_norm'] = stops_df['stop_name'].apply(normalizar)
        origen_norm = normalizar(origen)
        destino_norm = normalizar(destino)
        
        # Buscar stop_ids
        origen_stops = stops_df[stops_df['stop_name_norm'].str.contains(origen_norm, na=False)]
        destino_stops = stops_df[stops_df['stop_name_norm'].str.contains(destino_norm, na=False)]
        
        if origen_stops.empty or destino_stops.empty:
            raise ValueError(f"No se encontraron las estaciones en GTFS")
        
        origen_id = origen_stops.iloc[0]['stop_id']
        destino_id = destino_stops.iloc[0]['stop_id']
        
        # Buscar viajes que conecten ambas estaciones
        stop_times_origen = stop_times_df[stop_times_df['stop_id'] == origen_id]
        stop_times_destino = stop_times_df[stop_times_df['stop_id'] == destino_id]
        
        trip_ids_origen = set(stop_times_origen['trip_id'].unique())
        trip_ids_destino = set(stop_times_destino['trip_id'].unique())
        trip_ids_comunes = trip_ids_origen.intersection(trip_ids_destino)
        
        if not trip_ids_comunes:
            raise ValueError("No hay viajes que conecten ambas estaciones")
        
        rows = []
        for trip_id in trip_ids_comunes:
            hora_origen = stop_times_origen[stop_times_origen['trip_id'] == trip_id]['departure_time'].values
            if len(hora_origen) > 0:
                rows.append({
                    'origen': origen,
                    'destino': destino,
                    'hora_salida': hora_origen[0],
                    'trip_id': trip_id
                })
        
        if not rows:
            raise ValueError("No se encontraron horarios")
        
        return pd.DataFrame(rows).sort_values('hora_salida')
        
    except Exception as e:
        print(f"    GTFS falló: {e}")
        raise

# ====================================================
#  5. ORQUESTADOR DE MÉTODOS
# ====================================================
def obtener_fecha_para_tipo(tipo_dia):
    """Devuelve una fecha representativa para cada tipo de día."""
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

def get_trenes(origen, destino, tipo_dia):
    """Intenta múltiples métodos para obtener horarios."""
    fecha = obtener_fecha_para_tipo(tipo_dia)
    
    # Método 1: API (prioridad)
    try:
        print("  Intentando método: API SOFSE")
        df = fetch_from_api(origen, destino, fecha, "00:00", 60)
        if not df.empty:
            print("  ✅ Método 'API SOFSE' exitoso")
            return df
    except Exception as e:
        print(f"  ❌ Método 'API SOFSE' falló: {e}")

    # Método 2: GTFS (fallback)
    try:
        print("  Intentando método: GTFS")
        df = fetch_from_gtfs(origen, destino, tipo_dia)
        if not df.empty:
            print("  ✅ Método 'GTFS' exitoso")
            return df
    except Exception as e:
        print(f"  ❌ Método 'GTFS' falló: {e}")

    print(f"  ⚠️ Todos los métodos fallaron para {origen}->{destino} ({tipo_dia})")
    return pd.DataFrame()

# ====================================================
#  6. GUARDAR CSV (SOLO SI HAY CAMBIOS)
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
#  7. MAIN
# ====================================================
def main():
    with open("config/routes.yaml", "r") as f:
        config = yaml.safe_load(f)

    cambios = False
    for ruta in config["trenes"]:
        origen = ruta["origen"]
        destino = ruta["destino"]
        carpeta = ruta["carpeta"]
        print(f"\n📌 Procesando: {origen} -> {destino}")
        
        for tipo in ruta["tipos_dia"]:
            print(f"  📅 Tipo: {tipo}")
            
            # Ida
            print(f"    🚉 Ida: {origen} -> {destino}")
            df_ida = get_trenes(origen, destino, tipo)
            if not df_ida.empty:
                archivo = f"{origen}-{destino}-{tipo}.csv"
                ruta_archivo = os.path.join(carpeta, archivo)
                if guardar_si_cambia(df_ida, ruta_archivo):
                    cambios = True
            else:
                print(f"    ⚠️ No se obtuvieron datos para la ida")

            # Vuelta
            print(f"    🚉 Vuelta: {destino} -> {origen}")
            df_vuelta = get_trenes(destino, origen, tipo)
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