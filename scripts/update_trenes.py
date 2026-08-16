import os
import yaml
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
import zipfile
import io

# ====================================================
#  CONFIGURACIÓN
# ====================================================
GTFS_URL_CDN = "https://cdn.buenosaires.gob.ar/datosabiertos/datasets/trenes-gtfs/trenes-gtfs.zip"
API_BASE = "https://ariedro.dev/api-trenes"  # se usará como fallback, pero está rota
GTFS_OFFICIAL = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/f74dacd7-63df-4a56-80f5-b1f590c9199d"

# ====================================================
#  HELPER DE REINTENTOS (5 intentos, backoff exponencial)
# ====================================================
def fetch_with_retries(url, params=None, retries=5, backoff=1.5, timeout=20):
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
#  MÉTODO PRINCIPAL: GTFS desde CDN de Buenos Aires
# ====================================================
def fetch_from_gtfs_cdn(origen, destino):
    """Descarga y procesa el GTFS del CDN de Buenos Aires para obtener horarios."""
    try:
        # Descargar el zip
        resp = fetch_with_retries(GTFS_URL_CDN, retries=3)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            # Leer archivos necesarios
            with z.open("stops.txt") as f:
                stops_df = pd.read_csv(f)
            with z.open("stop_times.txt") as f:
                stop_times_df = pd.read_csv(f)
            with z.open("trips.txt") as f:
                trips_df = pd.read_csv(f)
            with z.open("routes.txt") as f:
                routes_df = pd.read_csv(f)
        
        # Buscar IDs de las estaciones (búsqueda flexible)
        origen_stop = stops_df[stops_df["stop_name"].str.contains(origen, case=False, na=False)]
        destino_stop = stops_df[stops_df["stop_name"].str.contains(destino, case=False, na=False)]
        
        if origen_stop.empty or destino_stop.empty:
            raise ValueError(f"No se encontraron las estaciones en GTFS: {origen} o {destino}")
        
        origen_id = origen_stop.iloc[0]["stop_id"]
        destino_id = destino_stop.iloc[0]["stop_id"]
        print(f"    GTFS: Estaciones encontradas (origen: {origen_id}, destino: {destino_id})")
        
        # Obtener los trip_ids que pasan por ambas estaciones
        # 1. Filtrar stop_times por las estaciones origen y destino
        stop_times_origen = stop_times_df[stop_times_df["stop_id"] == origen_id]
        stop_times_destino = stop_times_df[stop_times_df["stop_id"] == destino_id]
        
        # Obtener los trip_ids comunes
        trips_origen = set(stop_times_origen["trip_id"].unique())
        trips_destino = set(stop_times_destino["trip_id"].unique())
        trips_comunes = trips_origen.intersection(trips_destino)
        
        if not trips_comunes:
            raise ValueError("No hay viajes que conecten ambas estaciones")
        
        # Construir un DataFrame con los horarios de salida desde el origen
        # y llegada al destino (para cada trip_id)
        resultados = []
        for trip_id in trips_comunes:
            # Hora de salida desde el origen
            salida = stop_times_origen[stop_times_origen["trip_id"] == trip_id]["departure_time"].values
            if len(salida) == 0:
                continue
            hora_salida = salida[0]
            # Hora de llegada al destino
            llegada = stop_times_destino[stop_times_destino["trip_id"] == trip_id]["arrival_time"].values
            if len(llegada) == 0:
                continue
            hora_llegada = llegada[0]
            resultados.append({
                "origen": origen,
                "destino": destino,
                "hora_salida": hora_salida,
                "hora_llegada": hora_llegada,
                "trip_id": trip_id
            })
        
        if not resultados:
            raise ValueError("No se encontraron horarios para el par origen-destino")
        
        df = pd.DataFrame(resultados)
        # Ordenar por hora de salida
        df = df.sort_values("hora_salida")
        return df
        
    except Exception as e:
        print(f"    GTFS CDN falló: {e}")
        raise

# ====================================================
#  FALLBACKS (API y GTFS oficial, ambos rotos o inestables)
# ====================================================
def get_station_id(station_name):
    """Intenta obtener ID desde la API (proxy Ariedro) - actualmente falla."""
    try:
        resp = fetch_with_retries(f"{API_BASE}/infraestructura/estaciones", params={"nombre": station_name}, retries=2)
        data = resp.json()
        if not data:
            raise ValueError(f"No se encontró la estación: {station_name}")
        for estacion in data:
            if estacion.get("nombre", "").lower() == station_name.lower():
                return estacion.get("id")
        return data[0].get("id")
    except Exception as e:
        raise ValueError(f"No se pudo obtener ID para {station_name}: {e}")

def fetch_from_api(origen, destino, fecha, hora_inicio, cantidad=50):
    """Obtiene horarios desde la API (falla actualmente)."""
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
    for item in data:
        rows.append({
            "origen": origen,
            "destino": destino,
            "hora_salida": item.get("hora"),
            "fecha": item.get("fecha"),
            "servicio": item.get("servicio", ""),
            "tipo": item.get("tipo", "")
        })
    return pd.DataFrame(rows)

def fetch_from_gtfs_official(origen, destino):
    """GTFS oficial (enlace roto)."""
    try:
        resp = fetch_with_retries(GTFS_OFFICIAL, retries=2)
        # Si devuelve HTML, falla
        if "text/html" in resp.headers.get("Content-Type", ""):
            raise Exception("El recurso devuelve HTML, no ZIP")
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            # ... (similar al CDN, pero no llega)
            pass
    except Exception as e:
        raise Exception(f"GTFS oficial falló: {e}")

# ====================================================
#  ORQUESTADOR DE MÉTODOS
# ====================================================
def obtener_fecha_para_tipo(tipo_dia):
    """Devuelve una fecha representativa para el tipo de día (no se usa en GTFS, pero se mantiene)."""
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
    elif tipo_dia in ["Domingo", "NoLaboral"]:
        days_until = (6 - hoy.weekday()) % 7
        if days_until == 0:
            days_until = 7
        return (hoy + timedelta(days=days_until)).strftime("%Y-%m-%d")
    else:  # Feriados
        return hoy.strftime("%Y-%m-%d")

def get_trenes(origen, destino, tipo_dia):
    """Intenta múltiples métodos (prioridad: GTFS CDN → API → GTFS oficial)."""
    # Solo usamos GTFS CDN porque es el único que funciona
    # y devuelve datos en la estructura que necesitamos.
    metodos = [
        ("GTFS CDN", lambda: fetch_from_gtfs_cdn(origen, destino)),
        # ("API SOFSE", lambda: fetch_from_api(origen, destino, obtener_fecha_para_tipo(tipo_dia), "00:00", 50)),
        # ("GTFS oficial", lambda: fetch_from_gtfs_official(origen, destino))
    ]
    
    for nombre_metodo, func in metodos:
        try:
            print(f"  Intentando método: {nombre_metodo}")
            df = func()
            if not df.empty:
                print(f"  ✅ Método '{nombre_metodo}' exitoso")
                return df
        except Exception as e:
            print(f"  ❌ Método '{nombre_metodo}' falló: {e}")
            continue
    
    print(f"  ⚠️ Todos los métodos fallaron para {origen}->{destino} ({tipo_dia})")
    return pd.DataFrame()

# ====================================================
#  GUARDAR CSV (SOLO SI HAY CAMBIOS)
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
#  MAIN
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

    # Si hubo cambios, el workflow hará commit; si no, no hará nada.
    return 0 if cambios else 1

if __name__ == "__main__":
    main()