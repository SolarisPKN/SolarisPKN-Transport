import requests
from bs4 import BeautifulSoup
import re
import camelot
import pandas as pd
from io import BytesIO
import os
from datetime import datetime

# ====================================================
#  CONFIGURACIÓN
# ====================================================
URLS = {
    "Merlo-Lobos": "https://www.argentina.gob.ar/transporte/trenes-argentinos/horarios-tarifas-y-recorridos/areametropolitana/lineasarmiento/merlo-lobos",
    "Catan-Lozano": "https://www.argentina.gob.ar/transporte/trenes-argentinos/horarios-tarifas-y-recorridos-de-trenes/gonzalez-catan-lozano"
}

# ====================================================
#  1. OBTENER URL DEL PDF (VERSIÓN MEJORADA)
# ====================================================
def obtener_url_pdf(url_pagina):
    """Extrae la URL del PDF de horarios desde la página de un ramal."""
    try:
        response = requests.get(url_pagina, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        # --- MÉTODO 1: Buscar en meta description ---
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc and meta_desc.get('content'):
            content = meta_desc['content']
            match = re.search(r'https://[^\s\)]+\.pdf', content)
            if match:
                return match.group(0)

        # --- MÉTODO 2: Buscar botón "Horarios" (caso Merlo-Lobos) ---
        # Buscar todos los enlaces que contengan "Horarios" y terminen en .pdf
        for link in soup.find_all('a', href=True):
            texto = link.get_text(strip=True)
            href = link['href']
            if 'Horarios' in texto and href.endswith('.pdf'):
                if href.startswith('/'):
                    href = 'https://www.argentina.gob.ar' + href
                return href

        # --- MÉTODO 3: Buscar cualquier enlace que termine en .pdf ---
        for link in soup.find_all('a', href=True):
            if link['href'].endswith('.pdf'):
                pdf_url = link['href']
                if pdf_url.startswith('/'):
                    pdf_url = 'https://www.argentina.gob.ar' + pdf_url
                return pdf_url

        return None
    except Exception as e:
        print(f"Error al obtener la página: {e}")
        return None

# ====================================================
#  2. EXTRAER FECHA DE VIGENCIA DEL PDF
# ====================================================
def extraer_fecha_vigencia(texto_pagina):
    patrones = [
        r'[Vv]igencia\s*[:;]\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
        r'[Dd]esde\s*(?:el)?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
        r'[Vv]álido\s*(?:a\s*partir\s*de)?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
        r'[Ff]echa\s*[:;]\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
        r'(\d{2}[/-]\d{2}[/-]\d{4})'  # fallback: cualquier fecha en el texto
    ]
    for patron in patrones:
        match = re.search(patron, texto_pagina)
        if match:
            return match.group(1)
    return None

# ====================================================
#  3. PROCESAR PDF Y EXTRAER TABLAS (VERSIÓN MEJORADA)
# ====================================================
def procesar_pdf(url_pdf):
    """Descarga el PDF, extrae tablas y devuelve DataFrame + fecha vigencia."""
    resp = requests.get(url_pdf)
    resp.raise_for_status()
    pdf_bytes = BytesIO(resp.content)

    # Leer todas las tablas del PDF
    tables = camelot.read_pdf(pdf_bytes, pages='all', flavor='lattice')
    if not tables:
        tables = camelot.read_pdf(pdf_bytes, pages='all', flavor='stream')

    if not tables:
        raise ValueError("No se encontraron tablas en el PDF")

    # Extraer texto completo para buscar la vigencia
    import pdfplumber
    texto_completo = ""
    with pdfplumber.open(pdf_bytes) as pdf:
        for page in pdf.pages:
            texto_completo += page.extract_text() or ""

    fecha_vigencia = extraer_fecha_vigencia(texto_completo)

    # --- Procesar las tablas para identificar días y sentidos ---
    # El PDF tiene una estructura donde cada bloque de tablas corresponde a un día/sentido
    # Vamos a procesar cada tabla y tratar de identificar el encabezado

    all_data = []
    current_day = None
    current_direction = None

    # Palabras clave para identificar días y sentidos en el texto
    dias_keywords = {
        'Lunes a Viernes': ['Lunes', 'Viernes', 'LUNES', 'VIERNES', 'Lunes a Viernes'],
        'Sábado': ['Sábado', 'SABADO', 'Sabado'],
        'Domingo': ['Domingo', 'DOMINGO'],
        'Feriados': ['Feriados', 'FERIADOS']
    }

    for table in tables:
        df = table.df
        # Limpiar: eliminar filas vacías
        df = df.dropna(how='all')
        if df.empty:
            continue

        # Intentar identificar si esta tabla contiene un encabezado de día
        first_row = df.iloc[0].astype(str).str.cat(sep=' ')
        for day_name, keywords in dias_keywords.items():
            if any(kw in first_row for kw in keywords):
                current_day = day_name
                break

        # Intentar identificar el sentido (ida/vuelta) por las estaciones
        # Si la primera columna contiene "Tren N°" o números de tren, es una tabla de horarios
        first_col = df.iloc[:, 0].astype(str)
        if first_col.str.contains('Tren N°', case=False, na=False).any():
            # Esta es una tabla de horarios
            # Buscar la fila que contiene "Tren N°" para usarla como referencia
            header_row_idx = first_col[first_col.str.contains('Tren N°', case=False, na=False)].index
            if not header_row_idx.empty:
                header_idx = header_row_idx[0]
                # Las filas siguientes son los horarios
                for idx in range(header_idx + 1, len(df)):
                    row = df.iloc[idx]
                    if row.isnull().all():
                        continue
                    # La primera columna es el número de tren
                    tren_num = str(row.iloc[0]).strip()
                    if tren_num and tren_num != 'nan':
                        # Las siguientes columnas son los horarios por estación
                        # La estructura es: Tren N° | Estación1 | Estación2 | ...
                        # Pero puede variar, así que lo procesamos de forma flexible
                        horarios = []
                        for col_idx in range(1, len(row)):
                            hora = str(row.iloc[col_idx]).strip()
                            if hora and hora != 'nan':
                                horarios.append(hora)
                            else:
                                horarios.append('')
                        all_data.append({
                            'tren': tren_num,
                            'horarios': horarios,
                            'dia': current_day or 'Desconocido',
                            'sentido': current_direction or 'Desconocido'
                        })

    # Convertir a DataFrame más estructurado
    # Como la estructura es compleja, vamos a construir un DataFrame con columnas dinámicas
    if not all_data:
        raise ValueError("No se pudieron extraer horarios del PDF")

    # Crear un DataFrame con los datos extraídos
    rows = []
    for item in all_data:
        # Determinar el número de estaciones (puede variar)
        num_estaciones = len(item['horarios'])
        # Agregar una fila por cada horario (si hay múltiples estaciones)
        # En realidad, cada fila del CSV debería ser un viaje con todas las estaciones
        # Pero para simplificar, guardamos como está
        rows.append({
            'tren': item['tren'],
            'dia': item['dia'],
            'sentido': item['sentido'],
            'horarios': '|'.join(item['horarios'])  # concatenar horarios
        })

    final_df = pd.DataFrame(rows)
    return final_df, fecha_vigencia

# ====================================================
#  4. GUARDAR CSV
# ====================================================
def guardar_csv(df, fecha_vigencia, ramal):
    """Guarda el CSV con la fecha de vigencia en el nombre del archivo."""
    if fecha_vigencia:
        fecha_limpia = fecha_vigencia.replace('/', '-')
        nombre_archivo = f"{ramal}-vigencia_{fecha_limpia}.csv"
    else:
        nombre_archivo = f"{ramal}-sin_vigencia.csv"

    carpeta = os.path.join("Trenes", ramal)
    os.makedirs(carpeta, exist_ok=True)
    ruta_completa = os.path.join(carpeta, nombre_archivo)
    df.to_csv(ruta_completa, index=False)
    print(f"✅ Guardado: {ruta_completa}")
    return ruta_completa

# ====================================================
#  5. MAIN
# ====================================================
def main():
    for ramal, url_pagina in URLS.items():
        print(f"\n📌 Procesando: {ramal}")

        pdf_url = obtener_url_pdf(url_pagina)
        if not pdf_url:
            print(f"   ❌ No se pudo obtener el enlace al PDF para {ramal}")
            continue
        print(f"   ✅ PDF encontrado: {pdf_url}")

        try:
            df, fecha_vigencia = procesar_pdf(pdf_url)
            print(f"   📅 Fecha de vigencia: {fecha_vigencia if fecha_vigencia else 'No detectada'}")
            print(f"   📊 Datos extraídos: {len(df)} filas")
            print(df.head())
            guardar_csv(df, fecha_vigencia, ramal)
        except Exception as e:
            print(f"   ❌ Error al procesar el PDF: {e}")

if __name__ == "__main__":
    main()