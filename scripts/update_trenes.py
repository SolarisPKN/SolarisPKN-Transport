import os
import yaml
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
import zipfile
import io
import json

# ------------------------------------------------------------
# 1. Helper con reintentos (máximo 5)
# ------------------------------------------------------------
def fetch_with_retries(url, params=None, retries=5, backoff=1.5, timeout=15, method='GET'):
    for attempt in range(retries):
        try:
            if method == 'GET':
                resp = requests.get(url, params=params, timeout=timeout)
            elif method == 'POST':
                resp = requests.post(url, json=params, timeout=timeout)
            else:
                resp = requests.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp
        except (requests.RequestException, ConnectionError) as e:
            wait = backoff ** attempt
            print(f"  Intento {attempt+1}/{retries} falló: {e}. Reintentando en {wait:.1f}s...")
            time.sleep(wait)
    raise Exception(f"Todos los {retries} reintentos fallaron para {url}")

# ------------------------------------------------------------
# 2. Métodos de obtención de ID de estación
# ------------------------------------------------------------
def get_station_id_by_name(station_name):
    """Método 1: Buscar estación por nombre exacto"""
    base = "https://ariedro.dev/api-trenes"
    resp = fetch_with_retries(f"{base}/infraestructura/estaciones", params={"nombre": station_name})
    data = resp.json()
    if not data:
        raise ValueError(f"No se encontró la estación: {station_name}")
    # Buscar coincidencia exacta (case insensitive)
    for estacion in data:
        if estacion.get("nombre", "").lower() == station_name.lower():
            return estacion.get("id")
    # Si no hay coincidencia exacta, usar el primero
    return data[0].get("id")

def get_station_id_by_search(station_name):
    """Método 2: Buscar estación por búsqueda parcial"""
    base = "https://ariedro.dev/api-trenes"
    # Intentar con diferentes variantes del nombre
    variantes = [station_name, station_name.replace("á", "a").replace("é", "e").replace("í", "i").replace("ó", "o").replace("ú", "u")]
    for variante in variantes:
        try:
            resp = fetch_with_retries(f"{base}/infraestructura/estaciones", params={"nombre": variante}, retries=2)
            data = resp.json()
            if data:
                return data[0].get("id")
        except:
            continue
    raise ValueError(f"No se encontró la estación con ninguna variante: {station_name}")

def get_station_id_by_ramal(station_name):
    """Método 3: Buscar estación por ramal (Sarmiento o Belgrano Sur)"""
    base = "https://ariedro.dev/api-trenes"
    # Obtener todos los ramales
    resp = fetch_with_retries(f"{base}/infraestructura/ramales")
    ramales = resp.json()
    
    # Mapeo de nombres de ramales
    ramal_map = {
        "Sarmiento": ["Sarmiento", "Línea Sarmiento"],
        "Belgrano Sur": ["Belgrano Sur", "Línea Belgrano Sur"]
    }
    
    # Determinar a qué ramal pertenece la estación
    ramal_buscado = None
    if "Merlo" in station_name or "Lobos" in station_name:
        ramal_buscado = "Sarmiento"
    elif "González" in station_name or "Lozano" in station_name:
        ramal_buscado = "Belgrano Sur"
    
    if not ramal_buscado:
        raise ValueError(f"No se pudo determinar el ramal para: {station_name}")
    
    # Buscar el ID del ramal
    ramal_id = None
    for r in ramales:
        if r.get("nombre") in ramal_map.get(ramal_buscado, []):
            ramal_id = r.get("id")
            break
    
    if not ramal_id:
        raise ValueError(f"No se encontró el ramal: {ramal_buscado}")
    
    # Obtener estaciones del ramal
    resp = fetch_with_retries(f"{base}/infraestructura/estaciones", params={"ramal": ramal_id})
    estaciones = resp.json()
    
    for estacion in estaciones:
        if station_name.lower() in estacion.get("nombre", "").lower():
            return estacion.get("id")
    
    raise ValueError(f"No se encontró la estación {station_name} en el ramal {ramal_buscado}")

# ------------------------------------------------------------
# 3. Métodos de obtención de horarios
# ------------------------------------------------------------
def fetch_from_ariedro(origen, destino, fecha, hora_inicio, cantidad=40):
    """Obtiene horarios desde la API de Ariedro"""
    base = "https://ariedro.dev/api-trenes"
    
    # Intentar obtener IDs con diferentes métodos
    metodos_id = [
        ("nombre exacto", get_station_id_by_name),
        ("búsqueda parcial", get_station_id_by_search),
        ("por ramal", get_station_id_by_ramal)
    ]
    
    origen_id = None
    destino_id = None
    
    for nombre_metodo, func in metodos_id:
        try:
            if not origen_id:
                origen_id = func(origen)
                print(f"    ID de {origen} obtenido con método '{nombre_metodo}'")
            if not destino_id:
                destino_id = func(destino)
                print(f"    ID de {destino} obtenido con método '{nombre_metodo}'")
        except Exception as e:
            print(f"    Método '{nombre_metodo}' falló: {e}")
            continue
    
    if not origen_id or not destino_id:
        raise ValueError(f"No se pudieron obtener los IDs de las estaciones")
    
    params = {
        "hasta": destino_id,
        "fecha": fecha,
        "hora": hora_inicio,
        "cantidad": cantidad
    }
    resp = fetch_with_retries(f"{base}/arribos/estacion/{origen_id}", params=params)
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

def fetch_from_gtfs(origen, destino, url=None):
    """Método 4: GTFS estático desde el portal oficial"""
    if not url:
        url = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/trenes-gtfs.zip"
    try:
        resp = fetch_with_retries(url, retries=3)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            # Extraer archivos necesarios
            with z.open("stops.txt") as f:
                stops_df = pd.read_csv(f)
            with z.open("stop_times.txt") as f:
                stop_times_df = pd.read_csv(f)
            with z.open("trips.txt") as f:
                trips_df = pd.read_csv(f)
        
        # Buscar IDs de las estaciones
        origen_id = stops_df[stops_df["stop_name"].str.contains(origen, case=False)]["stop_id"].values
        destino_id = stops_df[stops_df["stop_name"].str.contains(destino, case=False)]["stop_id"].values
        
        if len(origen_id) == 0 or len(destino_id) == 0:
            raise ValueError(f"No se encontraron las estaciones en GTFS")
        
        origen_id = origen_id[0]
        destino_id = destino_id[0]
        
        # Filtrar viajes que pasan por ambas estaciones
        # (esto es una simplificación, en GTFS real se necesita más lógica)
        # Por ahora retornamos vacío para indicar que el GTFS no está implementado completamente
        print("GTFS: extracción completa pendiente de implementación")
        return pd.DataFrame()
    except Exception as e:
        print(f"GTFS falló: {e}")
        raise

def fetch_from_gtfs_mirror(origen, destino):
    """Método 5: GTFS desde espejo público"""
    # Intentar con diferentes mirrors
    mirrors = [
        "https://ckan.tdc.prod.datopian.com/dataset/trenes-gtfs/resource/trenes-gtfs.zip",
        "https://hub.tumidata.org/dataset/trenes-gtfs/resource/trenes-gtfs.zip"
    ]
    for mirror in mirrors:
        try:
            print(f"  Intentando mirror: {mirror}")
            return fetch_from_gtfs(origen, destino, url=mirror)
        except Exception as e:
            print(f"  Mirror falló: {e}")
            continue
    raise Exception("Todos los mirrors de GTFS fallaron")

# ------------------------------------------------------------
# 4. Mapeo de tipos de día a fechas representativas
# ------------------------------------------------------------
def obtener_fecha_para_tipo(tipo_dia):
    """Devuelve una fecha representativa para cada tipo de día"""
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

# ------------------------------------------------------------
# 5. Obtener horarios con múltiples métodos
# ------------------------------------------------------------
def get_trenes(origen, destino, tipo_dia):
    """Intenta múltiples métodos para obtener horarios"""
    fecha = obtener_fecha_para_tipo(tipo_dia)
    
    # Lista de métodos a probar (en orden de prioridad)
    metodos = [
        ("API Ariedro", lambda: fetch_from_ariedro(origen, destino, fecha, "00:00", 50)),
        ("GTFS oficial", lambda: fetch_from_gtfs(origen, destino)),
        ("GTFS espejo", lambda: fetch_from_gtfs_mirror(origen, destino))
    ]
    
    for nombre_metodo, func in metodos:
        try:
            print(f"  Intentando método: {nombre_metodo}")
            df = func()
            if not df.empty:
                print(f"  ✅ Método '{nombre_metodo}' exitoso")
                # Si el método devuelve datos, los procesamos
                # (algunos métodos pueden devolver solo un fragmento del día)
                return df
        except Exception as e:
            print(f"  ❌ Método '{nombre_metodo}' falló: {e}")
            continue
    
    # Si todos los métodos fallaron, devolver DataFrame vacío
    print(f"  ⚠️ Todos los métodos fallaron para {origen}->{destino} ({tipo_dia})")
    return pd.DataFrame()

# ------------------------------------------------------------
# 6. Guardar CSV solo si hay cambios
# ------------------------------------------------------------
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

# ------------------------------------------------------------
# 7. Orquestador principal
# ------------------------------------------------------------
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