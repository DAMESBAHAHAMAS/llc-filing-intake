import base64
import binascii
import hmac
import io
import os

from flask import Flask, Response, jsonify, request
from jinja2 import Environment, FileSystemLoader, StrictUndefined, TemplateNotFound, UndefinedError
from pypdf import PdfReader, PdfWriter
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


# Download filename suffix per template. Before the Operating Agreement
# templates existed, every PDF was named "..._Articles_of_Organization.pdf".
_DOCUMENT_LABELS = {
    "articles_of_organization": "Articles_of_Organization",
    "operating_agreement_single_member": "Operating_Agreement",
    "operating_agreement_multi_member": "Operating_Agreement",
    "formation_cover_letter": "Cover_Letter",
    "formation_next_steps": "Next_Steps",
    "formation_placeholder_page": "Placeholder",
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
