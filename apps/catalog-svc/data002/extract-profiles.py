"""Extrae datos de XLSX sin ejecutar fórmulas, macros ni instrucciones del documento."""
import hashlib
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal, InvalidOperation

ROOT = pathlib.Path(__file__).resolve().parent
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
FIELDS = ("peso_kg", "largo_cm", "ancho_cm", "alto_cm")
SOURCE_NAME = "DATA002_Perfiles_Fisicos_55_SKU_Carga_Academica_Codex.xlsx"


def extract(path):
    source = pathlib.Path(path)
    with zipfile.ZipFile(source) as archive:
        shared = ["".join(node.itertext()) for node in ET.fromstring(archive.read("xl/sharedStrings.xml"))] if "xl/sharedStrings.xml" in archive.namelist() else []
        relationships = {node.attrib["Id"]: node.attrib["Target"].lstrip("/") for node in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        sheets = {}
        for sheet in ET.fromstring(archive.read("xl/workbook.xml")).find("m:sheets", NS):
            target = relationships[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
            if not target.startswith("xl/"):
                target = "xl/" + target
            rows = []
            for row in ET.fromstring(archive.read(target)).findall("m:sheetData/m:row", NS):
                cells = {}
                for cell in row:
                    value = cell.find("m:v", NS)
                    inline = cell.find("m:is", NS)
                    raw = value.text if value is not None else ""
                    cells[cell.attrib["r"].rstrip("0123456789")] = {
                        "value": shared[int(raw)] if cell.attrib.get("t") == "s" else "".join(inline.itertext()) if inline is not None else raw,
                        "type": cell.attrib.get("t", "n"),
                        "formula": cell.find("m:f", NS).text if cell.find("m:f", NS) is not None else None,
                    }
                rows.append({"row": int(row.attrib["r"]), "cells": cells})
            sheets[sheet.attrib["name"]] = rows
    header = {col: cell["value"] for col, cell in sheets["CARGA_55"][0]["cells"].items()}
    profiles = []
    for row in sheets["CARGA_55"][1:]:
        data = {header[col]: cell["value"] for col, cell in row["cells"].items() if col in header}
        if not any(data.values()):
            continue
        for col, cell in row["cells"].items():
            if header.get(col) in ("sku", *FIELDS) and cell["formula"] is not None:
                raise ValueError(f"No se admiten fórmulas en datos de carga: {col}{row['row']}")
            if header.get(col) in FIELDS:
                try:
                    number = Decimal(cell["value"])
                except InvalidOperation as error:
                    raise ValueError(f"Medida inválida: {col}{row['row']}") from error
                if cell["type"] != "n" or not number.is_finite() or number <= 0:
                    raise ValueError(f"Se requiere número positivo finito: {col}{row['row']}")
        if any(not data.get(field) for field in ("sku", *FIELDS)):
            raise ValueError(f"Fila incompleta: {row['row']}")
        profiles.append({"source_row": row["row"], **data})
    if len(profiles) != 55 or len({row["sku"] for row in profiles}) != 55:
        raise ValueError("Se requieren exactamente 55 SKU únicos")
    return {"source": {"file": SOURCE_NAME, "repository_file": "sources/physical-profiles-academic.xlsx", "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "sheet": "CARGA_55", "range": "A2:R56", "method": "OpenXML read-only; números decimales exactos, sin ejecutar fórmulas ni instrucciones"}, "profiles": profiles, "supporting_sheets": {name: rows for name, rows in sheets.items() if name != "CARGA_55"}}


if __name__ == "__main__":
    source_path = sys.argv[1] if len(sys.argv) > 1 else ROOT / "sources" / "physical-profiles-academic.xlsx"
    result = extract(source_path)
    (ROOT / "sources" / "physical-profiles-extracted.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"profiles": len(result["profiles"]), "sha256": result["source"]["sha256"]}))
