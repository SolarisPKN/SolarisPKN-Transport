import requests
import camelot
import pdfplumber
import re
from datetime import datetime
from io import BytesIO

def obtener_url_pdf(url_pagina):
    """Extrae la URL del PDF desde la página de argentina.gob.ar."""
    try:
        response = requests.get(url_pagina, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc and meta_desc.get('content'):
            content = meta_desc['content']
            match = re.search(r'https://[^\s\)]+\.pdf', content)
            if match:
                return match.group(0)
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

def extraer_fecha_vigencia_pdf(pdf_bytes):
    """Extrae la fecha de vigencia del PDF usando múltiples métodos."""
    fechas_encontradas = []

    # --- Método 1: Buscar texto en el PDF (con pdfplumber) ---
    try:
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            texto_completo = ""
            for page in pdf.pages:
                texto = page.extract_text()
                if texto:
                    texto_completo += texto + "\n"
            # Buscar patrones comunes de fecha de vigencia
            patrones = [
                r'vigencia:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
                r'a partir del\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
                r'fecha de emisión:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
                r'válido desde\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
                r'horarios vigentes a partir del\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})',
                r'(\d{1,2}[/-]\d{1,2}[/-]\d{4})',  # cualquier fecha en formato dd/mm/yyyy
            ]
            for patron in patrones:
                matches = re.findall(patron, texto_completo, re.IGNORECASE)
                if matches:
                    # Tomar la primera fecha encontrada
                    fechas_encontradas.extend(matches)
                    break  # si encontramos una, no seguimos buscando más patrones
    except Exception as e:
        print(f"  Error al extraer texto del PDF: {e}")

    # --- Método 2: Leer metadatos del PDF (con pdfplumber) ---
    try:
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            metadata = pdf.metadata
            if metadata:
                for clave in ['CreationDate', 'ModDate', 'CreationDate', 'ModDate']:
                    if clave in metadata:
                        fecha_meta = metadata[clave]
                        # Ejemplo: "D:20260601120000" → 2026-06-01
                        match = re.search(r'D:(\d{4})(\d{2})(\d{2})', fecha_meta)
                        if match:
                            anio, mes, dia = match.groups()
                            fechas_encontradas.append(f"{dia}/{mes}/{anio}")
                            break
    except Exception as e:
        print(f"  Error al leer metadatos del PDF: {e}")

    # --- Método 3: Extraer del nombre del archivo (se pasa por separado) ---
    # (lo haremos desde la función principal)

    # Limpiar y normalizar fechas
    fechas_unicas = list(set(fechas_encontradas))
    if fechas_unicas:
        # Ordenar por fecha (la más reciente primero)
        fechas_ordenadas = []
        for f in fechas_unicas:
            try:
                # Intentar parsear en varios formatos
                for fmt in ['%d/%m/%Y', '%d-%m-%Y', '%d/%m/%y', '%d-%m-%y']:
                    try:
                        dt = datetime.strptime(f, fmt)
                        fechas_ordenadas.append((dt, f))
                        break
                    except:
                        continue
            except:
                pass
        fechas_ordenadas.sort(reverse=True)
        if fechas_ordenadas:
            return fechas_ordenadas[0][1]  # devolver la más reciente

    return None

def extraer_tablas_y_vigencia(pdf_url):
    """Descarga el PDF, extrae tablas y fecha de vigencia."""
    print(f"📥 Descargando PDF desde: {pdf_url}")
    resp = requests.get(pdf_url)
    resp.raise_for_status()
    pdf_bytes = resp.content

    # 1. Extraer fecha de vigencia
    fecha_vigencia = extraer_fecha_vigencia_pdf(pdf_bytes)
    if fecha_vigencia:
        print(f"📅 Fecha de vigencia encontrada: {fecha_vigencia}")
    else:
        print("⚠️ No se pudo determinar la fecha de vigencia.")

    # 2. Extraer tablas con camelot
    print("🔍 Extrayendo tablas del PDF...")
    tables = camelot.read_pdf(BytesIO(pdf_bytes), pages='all', flavor='lattice')
    print(f"   Tablas encontradas: {len(tables)}")
    for i, table in enumerate(tables):
        print(f"   Tabla {i+1}: {table.shape[0]} filas, {table.shape[1]} columnas")

    # Devolver ambas cosas
    return {
        'fecha_vigencia': fecha_vigencia,
        'tablas': tables
    }