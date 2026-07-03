import os

from flask import Flask, Response, jsonify, request
from jinja2 import Environment, FileSystemLoader, TemplateNotFound
from weasyprint import HTML
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

app = Flask(__name__)

jinja_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=True,
)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/generate-pdf", methods=["POST"])
def generate_pdf():
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

    html_string = template.render(**context)

    # In-memory only — write_pdf() with no target returns bytes, nothing touches disk.
    pdf_bytes = HTML(string=html_string, base_url=BASE_DIR).write_pdf()

    llc_name = context.get("llc_name") or "Articles_of_Organization"
    filename = secure_filename(f"{llc_name}_Articles_of_Organization.pdf")

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
