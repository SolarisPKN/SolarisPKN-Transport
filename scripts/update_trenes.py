import os
import yaml
import time
import requests
import pandas as pd
from datetime import datetime, timedelta
import zipfile
import io

# ------------------------------------------------------------
# 1. Helper con reintentos (máximo 5)
# ------------------------------------------------------------
def fetch_with_retries(url, params=None, retries=5, backoff=1.5, timeout=15):
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp
        except (requests.RequestException, ConnectionError) as e:
            wait = backoff ** attempt
            print(f"Intento {attempt+1}/{retries} falló: {e}. Reintentando en {wait:.1f}s...")
            time.sleep(wait)
    raise Exception(f"Todos los {retries} reintentos fallaron para {url}")

# ------------------------------------------------------------
# 2. Fuente primaria: API Ariedro
# ------------------------------------------------------------
def get_station_id(station_name):
    base = "https://ariedro.dev/api-trenes"
    resp = fetch_with_retries(f"{base}/infraestructura/estaciones", params={"nombre": station_name})
    data = resp.json()
    if not data:
        raise ValueError(f"No se encontró la estación: {station_name}")
    return data[0]["id"]

def fetch_from_ariedro(origen, destino, fecha, hora_inicio, cantidad=40):
    base = "https://ariedro.dev/api-trenes"
    origen_id = get_station_id(origen)
    destino_id = get_station_id(destino)
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

# ------------------------------------------------------------
# 3. Fuente secundaria (fallback): GTFS estático (cuando se reactive)
# ------------------------------------------------------------
def fetch_from_gtfs(origen, destino):
    gtfs_url = "https://data.buenosaires.gob.ar/dataset/trenes-gtfs/resource/trenes-gtfs.zip"
    try:
        resp = fetch_with_retries(gtfs_url, retries=3)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            with z.open("stop_times.txt") as f:
                df = pd.read_csv(f)
        # TODO: implementar mapeo de nombres de estaciones a stop_ids cuando el GTFS se reactive
        print("GTFS aún no implementado (esperando reactivación).")
        return pd.DataFrame()
    except Exception as e:
        print(f"GTFS falló: {e}")
        raise

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
    else:  # Feriados (usamos hoy como referencia)
        return hoy.strftime("%Y-%m-%d")

# ------------------------------------------------------------
# 5. Obtener horarios para un tipo de día
# ------------------------------------------------------------
def get_trenes(origen, destino, tipo_dia):
    fecha = obtener_fecha_para_tipo(tipo_dia)
    all_dfs = []
    for hora in range(0, 24, 2):
        hora_str = f"{hora:02d}:00"
        try:
            df = fetch_from_ariedro(origen, destino, fecha, hora_str, cantidad=30)
            if not df.empty:
                all_dfs.append(df)
        except Exception as e:
            print(f"Error en Ariedro para {origen}->{destino} a las {hora_str}: {e}")

    if all_dfs:
        df_final = pd.concat(all_dfs).drop_duplicates(subset=["hora_salida"]).sort_values("hora_salida")
        return df_final
    else:
        print(f"Fallback a GTFS para {origen}->{destino} ({tipo_dia})")
        return fetch_from_gtfs(origen, destino)

# ------------------------------------------------------------
# 6. Guardar CSV solo si hay cambios
# ------------------------------------------------------------
def guardar_si_cambia(df, ruta):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    if os.path.exists(ruta):
        old_df = pd.read_csv(ruta)
        if df.equals(old_df):
            print(f"Sin cambios en {ruta}")
            return False
    df.to_csv(ruta, index=False)
    print(f"Actualizado {ruta}")
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
        for tipo in ruta["tipos_dia"]:
            # Ida
            df_ida = get_trenes(origen, destino, tipo)
            if not df_ida.empty:
                archivo = f"{origen}-{destino}-{tipo}.csv"
                ruta_archivo = os.path.join(carpeta, archivo)
                if guardar_si_cambia(df_ida, ruta_archivo):
                    cambios = True

            # Vuelta (intercambiar origen/destino)
            df_vuelta = get_trenes(destino, origen, tipo)
            if not df_vuelta.empty:
                archivo = f"{destino}-{origen}-{tipo}.csv"
                ruta_archivo = os.path.join(carpeta, archivo)
                if guardar_si_cambia(df_vuelta, ruta_archivo):
                    cambios = True

    # Retornamos 0 si hubo cambios, 1 si no (para que el Action sepa)
    return 0 if cambios else 1

if __name__ == "__main__":
    main()