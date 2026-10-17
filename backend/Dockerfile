FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
EXPOSE 5000
CMD ["python", "-c", "from waitress import serve; from ecolephant import create_app; serve(create_app(), host='0.0.0.0', port=5000, threads=4)"]
