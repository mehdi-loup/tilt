# Cloud Run image for the Wayfinder Python sidecar.
FROM python:3.12-slim

WORKDIR /app

# git: py-solc-x / some web3 deps resolve VCS refs; build-essential covers any
# sdist without a cp312 wheel. Kept minimal; most deps ship manylinux wheels.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY execute.py server.py ./

ENV PORT=8080
EXPOSE 8080
CMD ["python", "server.py"]
