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
API_BASE = "https://ariedro.dev/api-trenes"
GTFS_URL_1 = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/f74dacd7-63df-4a56-80f5-b1f590c9199d"
GTFS_URL_2 = "https://cdn.buenosaires.gob.ar/datosabiertos/datasets/trenes-gtfs/trenes-gtfs.zip"
GTFS_URL_3 = "https://mobilitydatabase.org/feeds/gtfs/mdb-647"  # Página, no el zip directo

# ====================================================
#  1. HELPER DE REINTENTOS
# ====================================================
def fetch_with_retries(url, params=None, retries=5, backoff=1.5, timeout=15):
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
#  2. MÉTODO 1: API SOFSE (proxy Ariedro)
# ====================================================
def get_station_id(station_name):
    """Busca el ID de una estación por nombre."""
    resp = fetch_with_retries(f"{API_BASE}/infraestructura/estaciones", params={"nombre": station_name})
    data = resp.json()
    if not data:
        raise ValueError(f"No se encontró la estación: {station_name}")
    # Buscar coincidencia exacta (case insensitive)
    for estacion in data:
        if estacion.get("nombre", "").lower() == station_name.lower():
            return estacion.get("id")
    # Si no hay coincidencia exacta, usar el primero
    return data[0].get("id")

def fetch_from_sofse_api(origen, destino, fecha, hora_inicio, cantidad=50):
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

# ====================================================
#  3. MÉTODO 2: GTFS OFICIAL
# ====================================================
def fetch_from_gtfs(origen, destino, gtfs_url):
    """Descarga y procesa el feed GTFS."""
    try:
        resp = fetch_with_retries(gtfs_url, retries=3)
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
            raise ValueError(f"No se encontraron las estaciones en GTFS")
        
        origen_id = origen_stop.iloc[0]["stop_id"]
        destino_id = destino_stop.iloc[0]["stop_id"]
        
        # Filtrar viajes que pasan por ambas estaciones
        # (búsqueda simplificada: asumimos que el viaje tiene ambas paradas)
        # En un caso real, habría que unir con stop_times y buscar coincidencias
        # Por ahora, devolvemos un DataFrame vacío si no se puede procesar completamente
        print(f"    GTFS: Estaciones encontradas (origen: {origen_id}, destino: {destino_id})")
        print("    GTFS: Procesamiento completo pendiente de implementación detallada")
        return pd.DataFrame()
        
    except Exception as e:
        print(f"    GTFS falló: {e}")
        raise

# ====================================================
#  4. ORQUESTADOR DE MÉTODOS
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
    elif tipo_dia in ["Domingo", "NoLaboral"]:
        days_until = (6 - hoy.weekday()) % 7
        if days_until == 0:
            days_until = 7
        return (hoy + timedelta(days=days_until)).strftime("%Y-%m-%d")
    else:  # Feriados
        return hoy.strftime("%Y-%m-%d")

def get_trenes(origen, destino, tipo_dia):
    """Intenta múltiples métodos para obtener horarios."""
    fecha = obtener_fecha_para_tipo(tipo_dia)
    
    # Lista de métodos a probar (en orden de prioridad)
    metodos = [
        ("API SOFSE", lambda: fetch_from_sofse_api(origen, destino, fecha, "00:00", 50)),
        ("GTFS (oficial)", lambda: fetch_from_gtfs(origen, destino, GTFS_URL_1)),
        ("GTFS (CDN)", lambda: fetch_from_gtfs(origen, destino, GTFS_URL_2)),
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
#  5. GUARDAR CSV (SOLO SI HAY CAMBIOS)
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