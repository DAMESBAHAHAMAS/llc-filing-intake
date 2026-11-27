import base64
import binascii
import hmac
import io
import os
import re

from flask import Flask, Response, jsonify, request
from jinja2 import Environment, FileSystemLoader, StrictUndefined, TemplateNotFound, UndefinedError
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject
from weasyprint import HTML
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

app = Flask(__name__)

# StrictUndefined: Gate 2 test-matrix requirement — "missing PDF variable
# surfaces as a completeness gap, not a fabricated value or silent
# failure." The default Jinja Undefined renders a missing variable as an
# empty string, which on a real legal document (e.g. a blank LLC name)
# is exactly the silent-bad-data failure mode this project's own
# standing rules forbid. StrictUndefined makes template.render() raise
# UndefinedError instead — caught below and turned into a 422 naming the
# missing field, not a 200 with a blank PDF.
jinja_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=True,
    undefined=StrictUndefined,
)

# Shared-secret auth: this service was previously reachable by anyone on
# the public internet with no auth at all — an unauthenticated,
# CPU-intensive (WeasyPrint) endpoint is a real DoS/abuse surface, not
# just a style nit. PDF_SERVICE_API_KEY is optional so local dev without
# it keeps working, but its absence is logged loudly rather than silently
# accepted — see DECISIONS.md.
_PDF_SERVICE_API_KEY = os.environ.get("PDF_SERVICE_API_KEY")
if not _PDF_SERVICE_API_KEY:
    print("[render_pdf] WARNING: PDF_SERVICE_API_KEY is not set — /generate-pdf is UNAUTHENTICATED.")


def _is_authorized(req) -> bool:
    if not _PDF_SERVICE_API_KEY:
        return True
    supplied = req.headers.get("X-PDF-Service-Key", "")
    return hmac.compare_digest(supplied, _PDF_SERVICE_API_KEY)


# Sunbiz Fax Audit Number (see server/src/pdf/faxAudit.ts, which validates first). It is printed
# inside a CSS string in the template, so it is checked again here against the same pattern.
_FAX_AUDIT_NUMBER = re.compile(r"[A-Z][0-9]{11} [0-9]")

# Download filename suffix per template. Before the Operating Agreement
# templates existed, every PDF was named "..._Articles_of_Organization.pdf".
_DOCUMENT_LABELS = {
    "articles_of_organization": "Articles_of_Organization",
    "operating_agreement_single_member": "Operating_Agreement",
    "operating_agreement_multi_member": "Operating_Agreement",
    "formation_cover_letter": "Cover_Letter",
    "formation_next_steps": "Next_Steps",
    "formation_placeholder_page": "Placeholder",
    "banking_resolution_single_member": "Banking_Resolution",
    "banking_resolution_multi_member": "Banking_Resolution",
}


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/generate-pdf", methods=["POST"])
def generate_pdf():
    if not _is_authorized(request):
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Request body must be JSON"}), 400

    template_name = body.get("template")
    context = body.get("context") or {}

    if not template_name:
        return jsonify({"error": "'template' is required"}), 400

    fax_audit_number = context.get("fax_audit_number")
    if fax_audit_number not in (None, "") and not (
        isinstance(fax_audit_number, str) and _FAX_AUDIT_NUMBER.fullmatch(fax_audit_number)
    ):
        return jsonify({"error": "fax_audit_number must be a letter, eleven digits, a space and a check digit"}), 422

    try:
        template = jinja_env.get_template(f"{template_name}.html.j2")
    except TemplateNotFound:
        return jsonify({"error": f"Unknown template: {template_name}"}), 404

    try:
        html_string = template.render(**context)
    except UndefinedError as err:
        # Completeness gap, not a crash — the caller (llc-data-spine) is
        # expected to treat this as "form is not yet complete enough to
        # file," never invent/stub a value and retry silently.
        return jsonify({"error": "missing required template variable", "detail": str(err)}), 422

    # In-memory only — write_pdf() with no target returns bytes, nothing touches disk.
    pdf_bytes = HTML(string=html_string, base_url=BASE_DIR).write_pdf()

    document_label = _DOCUMENT_LABELS.get(template_name, template_name)
    llc_name = context.get("llc_name") or document_label
    filename = secure_filename(f"{llc_name}_{document_label}.pdf")

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── IRS Form SS-4 (T144 Dispatch 11) ─────────────────────────────────────
# Fills the official fillable Form SS-4 (assets/irs/fss4.pdf, see SOURCE.md)
# with values built by server/src/ein/ss4.ts. Fills only: nothing here faxes,
# files or stores anything. An unknown field name is refused (422), so an IRS
# revision of the form can never silently drop a line.
SS4_PATH = os.path.join(BASE_DIR, "assets", "irs", "fss4.pdf")
SS4_PREFIX = "topmostSubform[0].Page1[0]."
_SS4_MAX_TEXT = 200
_WATERMARK = re.compile(r"[A-Za-z0-9 .,:\-]{1,40}")


def _ss4_widgets(writer):
    """short field name -> (qualified name, field type, on-states) for every widget on page 1."""
    out = {}
    for annot in writer.pages[0].get("/Annots", []):
        a = annot.get_object()
        if a.get("/Subtype") != "/Widget" or "/T" not in a:
            continue
        name = str(a["/T"])
        parent = a.get("/Parent")
        qualified = name
        while parent is not None:
            p = parent.get_object()
            if "/T" in p:
                qualified = f"{p['/T']}.{qualified}"
            parent = p.get("/Parent")
        short = qualified[len(SS4_PREFIX):] if qualified.startswith(SS4_PREFIX) else qualified
        states = []
        ap = a.get("/AP", {}).get("/N") if a.get("/AP") else None
        if ap is not None and hasattr(ap, "keys"):
            states = [k for k in ap.keys() if k != "/Off"]
        out[short] = (a, str(a.get("/FT", "")), states)
    return out


@app.route("/generate-ss4", methods=["POST"])
def generate_ss4():
    if not _is_authorized(request):
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("values"), dict):
        return jsonify({"error": "body must be an object with a 'values' object"}), 400
    values = body["values"]
    text = values.get("text") or {}
    checks = values.get("check") or []
    font_sizes = values.get("font_size") or {}
    watermark = body.get("watermark")

    if not isinstance(text, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in text.items()):
        return jsonify({"error": "values.text must map field names to strings"}), 400
    if not isinstance(checks, list) or not all(
        isinstance(c, list) and len(c) == 2 and all(isinstance(x, str) for x in c) for c in checks
    ):
        return jsonify({"error": "values.check must be a list of [field, on_state] pairs"}), 400
    if not isinstance(font_sizes, dict) or not all(
        isinstance(k, str) and k in text and isinstance(v, (int, float)) and not isinstance(v, bool) and 5 <= v <= 12
        for k, v in font_sizes.items()
    ):
        return jsonify({"error": "values.font_size must map filled text fields to 5-12 pt"}), 422
    if any(len(v) > _SS4_MAX_TEXT for v in text.values()):
        return jsonify({"error": f"text values are limited to {_SS4_MAX_TEXT} characters"}), 422
    if watermark is not None and not (isinstance(watermark, str) and _WATERMARK.fullmatch(watermark)):
        return jsonify({"error": "watermark must be 1-40 letters, digits, spaces or . , : -"}), 422

    writer = PdfWriter(clone_from=PdfReader(SS4_PATH))
    widgets = _ss4_widgets(writer)

    unknown = sorted(
        [k for k in text if k not in widgets or widgets[k][1] != "/Tx"]
        + [f for f, _ in checks if f not in widgets or widgets[f][1] != "/Btn"]
    )
    if unknown:
        return jsonify({"error": "unknown or mismatched SS-4 fields (form revised?)", "fields": unknown}), 422
    if sum(1 for f, _ in checks if f.startswith("c1_3[")) > 1:
        return jsonify({"error": "line 9a takes exactly one entity type"}), 422
    bad_states = sorted(f for f, on in checks if on not in widgets[f][2])
    if bad_states:
        return jsonify({"error": "checkbox on-state not on this form revision", "fields": bad_states}), 422

    # The IRS form is a hybrid: an XFA copy of the form (with empty data) sits
    # beside the AcroForm. XFA-aware viewers (Acrobat, Reader) would show that
    # empty copy, so the filled output keeps only the AcroForm.
    acroform = writer._root_object["/AcroForm"]
    if "/XFA" in acroform:
        del acroform["/XFA"]
    # The IRS file carries a Reader-extensions usage-rights signature (/Perms /UR3).
    # Any change invalidates it and Reader then warns that the document was altered
    # and disables features. The filled copy is ours, so drop the stale signature.
    if "/Perms" in writer._root_object:
        del writer._root_object["/Perms"]

    # A smaller font for a field whose text would not fit (line 9a's write-in).
    for field, size in font_sizes.items():
        widget = widgets[field][0]
        # The widget's own /DA, else its field's (parent), else the form default.
        da = ""
        node = widget
        while node is not None and not da:
            da = str(node.get("/DA", "") or "")
            parent = node.get("/Parent")
            node = parent.get_object() if parent is not None else None
        da = da or str(acroform.get("/DA", "") or "")
        new_size = f"{float(size):.2f} Tf"
        if re.search(r"[0-9.]+ Tf", da):
            da = re.sub(r"[0-9.]+ Tf", new_size, da, count=1)
        else:
            da = f"/Helv {new_size} 0 g"
        widget[NameObject("/DA")] = TextStringObject(da)

    writer.update_page_form_field_values(
        writer.pages[0], {SS4_PREFIX + k: v for k, v in text.items()}, auto_regenerate=False
    )
    for field, on in checks:
        widget = widgets[field][0]
        widget[NameObject("/V")] = NameObject(on)
        widget[NameObject("/AS")] = NameObject(on)
    writer.set_need_appearances_writer(True)

    if watermark:
        mark = HTML(string=(
            "<style>@page{size:letter;margin:0}body{margin:0;height:11in;display:flex;align-items:center;"
            "justify-content:center}p{transform:rotate(-30deg);font:bold 40pt sans-serif;"
            "color:rgba(200,0,0,.18);white-space:nowrap}</style>"
            f"<p>{watermark}</p>"
        )).write_pdf()
        writer.pages[0].merge_page(PdfReader(io.BytesIO(mark)).pages[0], over=True)

    buf = io.BytesIO()
    writer.write(buf)
    return Response(
        buf.getvalue(),
        mimetype="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="Form_SS-4.pdf"'},
    )


# Formation package assembly: joins PDFs that were already rendered (or,
# for the state's filing confirmation, received) into one file, in the
# order given. Nothing is written to disk.
_MAX_MERGE_PARTS = 10
_MAX_MERGE_BYTES = 25 * 1024 * 1024


@app.route("/merge-pdf", methods=["POST"])
def merge_pdf():
    if not _is_authorized(request):
        return jsonify({"error": "unauthorized"}), 401

    body = request.get_json(silent=True) or {}
    parts = body.get("pdfs")
    if not isinstance(parts, list) or not parts:
        return jsonify({"error": "'pdfs' must be a non-empty list of base64 strings"}), 400
    if len(parts) > _MAX_MERGE_PARTS:
        return jsonify({"error": f"at most {_MAX_MERGE_PARTS} parts"}), 400

    writer = PdfWriter()
    total = 0
    for i, encoded in enumerate(parts):
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, TypeError, ValueError):
            return jsonify({"error": f"part {i} is not valid base64"}), 400
        total += len(raw)
        if total > _MAX_MERGE_BYTES:
            return jsonify({"error": "parts exceed the size limit"}), 413
        if not raw.startswith(b"%PDF"):
            return jsonify({"error": f"part {i} is not a PDF"}), 400
        try:
            writer.append(PdfReader(io.BytesIO(raw)))
        except Exception as err:  # malformed PDF
            return jsonify({"error": f"part {i} could not be read: {err}"}), 422

    out = io.BytesIO()
    writer.write(out)
    filename = secure_filename(f"{body.get('filename') or 'Formation_Package'}.pdf")
    return Response(
        out.getvalue(),
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
