# syntax=docker/dockerfile:1

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --system optimizer && \
    useradd --system --gid optimizer --home-dir /app optimizer

WORKDIR /app

COPY services/optimizer/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt

COPY --chown=optimizer:optimizer services/optimizer/server.py ./server.py
COPY --chown=optimizer:optimizer services/optimizer/solver.py ./solver.py
COPY --chown=optimizer:optimizer services/optimizer/pyvrp_solver.py ./pyvrp_solver.py

USER optimizer

EXPOSE 8765

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=2).read()"]

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8765"]
