"""
convert_to_json.py
 
Step 3 of the MitProject manual pipeline.
 
Reads cleaned_manual_text.txt (produced by clean_manual_text.py) and
converts it into manual_pages.json: a structured, machine-readable
representation of the manual, one entry per page.
 
This is intentionally a *basic* structure (page-level granularity, not
individual-rule parsing) — good enough to load, search, and feed to an
LLM or downstream script. Rule-level parsing (e.g. splitting out G301,
R101, etc. as separate records) is a natural next step once this basic
structure is working end to end.
 
JSON shape:
{
  "document_metadata": {
    "title": "...",
    "game_name": "DECODE",
    "presented_by": "RTX",
    "season": "2025-2026",
    "team_update": "32",
    "source_pdf": "manual.pdf",
    "total_pages": 188,
    "generated_at": "2026-07-08T..."
  },
  "pages": [
    {
      "page_number": 1,
      "section": null,
      "is_blank": false,
      "text": "Team Update 32\n\n2025-2026 FIRST® Tech Challenge..."
    },
    ...
  ]
}
 
Usage (Command Prompt):
    cd C:\\Users\\Sarthak\\OneDrive\\Documents\\MitProject
    python convert_to_json.py
"""
 
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
 
INPUT_TXT = "cleaned_manual_text.txt"
OUTPUT_JSON = "manual_pages.json"
SOURCE_PDF_NAME = "manual.pdf"
 
PAGE_SPLIT_RE = re.compile(r"<<<PAGE (\d+)>>>")
SECTION_TAG_RE = re.compile(r"\A\[Section:\s*(?P<section>[^\]]+)\]\s*\n*")
 
 
def parse_cleaned_text(cleaned_text: str):
    pieces = PAGE_SPLIT_RE.split(cleaned_text)
    pieces = pieces[1:]  # drop leading empty string before PAGE 1
 
    pages = []
    for i in range(0, len(pieces), 2):
        page_num = int(pieces[i])
        body = pieces[i + 1].strip("\n")
 
        section = None
        match = SECTION_TAG_RE.match(body)
        if match:
            section = match.group("section").strip()
            body = body[match.end():]
 
        body = body.strip()
 
        pages.append({
            "page_number": page_num,
            "section": section,
            "is_blank": len(body) == 0,
            "text": body,
        })
 
    return pages
 
 
def build_json(input_path: str, output_path: str) -> None:
    in_file = Path(input_path)
    if not in_file.exists():
        print(f"ERROR: Could not find '{input_path}'.")
        print("Run clean_manual_text.py first to generate it.")
        sys.exit(1)
 
    cleaned_text = in_file.read_text(encoding="utf-8")
    pages = parse_cleaned_text(cleaned_text)
 
    document = {
        "document_metadata": {
            "title": "FIRST Tech Challenge Competition Manual",
            "game_name": "DECODE",
            "presented_by": "RTX",
            "season": "2025-2026",
            "team_update": "32",
            "source_pdf": SOURCE_PDF_NAME,
            "total_pages": len(pages),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "pages": pages,
    }
 
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(document, f, indent=2, ensure_ascii=False)
 
    blank_count = sum(1 for p in pages if p["is_blank"])
    sectioned_count = sum(1 for p in pages if p["section"])
    print(f"Wrote {len(pages)} pages -> '{output_path}'")
    print(f"  Blank pages: {blank_count}")
    print(f"  Pages tagged with a section: {sectioned_count}")
 
 
if __name__ == "__main__":
    build_json(INPUT_TXT, OUTPUT_JSON)
 