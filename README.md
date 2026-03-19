# Unofficial Kick App

<p align="center">
  <img src="static/Kick_logo.svg" alt="Kick Logo" width="100"/>
</p>

<p align="center">
  <strong>A lightweight, self-hosted web application and proxy API for Kick.com.</strong>
</p>

---

## Introduction

This project provides a user-friendly web interface and a proxy API for interacting with Kick.com's live streams and VODs. It is designed to be lightweight, easy to deploy, and highly configurable. The application is built with Flask and vanilla JavaScript, and it can be run in a Docker container, making it ideal for deployment on a home server or a Raspberry Pi.

## Features

*   **Web UI:** A clean and modern web interface for checking the status of Kick channels, browsing VODs, and watching featured live streams.
*   **Proxy API:** A RESTful API that provides programmatic access to Kick's live stream and VOD data.
*   **Cloudflare Bypass:** Built-in Cloudflare bypass using Cloudscraper to avoid 403 errors.
*   **Caching:** In-memory caching for API responses to reduce the load on Kick's servers and improve performance.
*   **Docker Support:** Comes with a `Dockerfile` and `docker-compose.yaml` for easy deployment.
*   **Swagger Documentation:** Interactive API documentation powered by Swagger UI.

## Tech Stack

*   **Backend:** Python, Flask, Flask-RESTX, Gunicorn
*   **Frontend:** HTML, CSS, JavaScript
*   **Deployment:** Docker, Docker Compose

## Getting Started

### Prerequisites

*   Docker and Docker Compose
*   Git

### Installation

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/<you>/kick-api.git
    cd kick-api
    ```

2.  **Run with Docker Compose:**

    ```bash
    docker-compose up --build
    ```

The application will be available at `http://localhost:8081`.

### Development

If you want to run the application without Docker for development purposes, you can follow these steps:

1.  **Create and activate a virtual environment:**

    ```bash
    python -m venv .venv
    source .venv/bin/activate
    ```

2.  **Install the dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

3.  **Run the application:**

    ```bash
    python app.py
    ```

The application will be available at `http://localhost:8081`.

## Usage

### Web UI

The web UI provides a simple and intuitive way to interact with the application. You can:

*   Enter a Kick channel slug to check its live status and browse its VODs.
*   View a list of featured live streams and filter them by language.
*   Sort the VODs and featured streams by various criteria.
*   Copy the stream URL to play it in a media player like VLC.

### API

The API provides programmatic access to the application's features. Here are the available endpoints:

| Endpoint                          | Method | Description                                           |
| --------------------------------- | ------ | ----------------------------------------------------- |
| `/streams/play/{channel_slug}`    | GET    | Returns live stream data for a given channel.         |
| `/streams/vods/{channel_slug}`    | GET    | Returns a list of VODs for a given channel.           |
| `/streams/vods/{channel_slug}/{vod_id}` | GET    | Redirects to the M3U8 URL of a specific VOD.          |
| `/streams/featured-livestreams`   | GET    | Returns a list of featured live streams.              |
| `/streams/go/{channel_slug}`      | GET    | Redirects to the live stream URL for a given channel. |

## API Documentation

The API is fully documented using Swagger UI. You can access the interactive documentation at `/docs` when the application is running.

## Configuration

The application can be configured using environment variables. Here is a list of the available variables:

| Variable                        | Default                                     | Description                                      |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `FLASK_DEBUG`                   | `False`                                     | Set to `True` for development mode.              |
| `PORT`                          | `8081`                                      | The port the application listens on.             |
| `LOG_LEVEL`                     | `INFO`                                      | The logging level.                               |
| `DEFAULT_LANGUAGE_CODE`         | `tr`                                        | The default language for featured streams.       |
| `KICK_API_BASE_URL`             | `https://kick.com/api/v2/channels/`         | The base URL for the Kick API.                   |
| `KICK_FEATURED_LIVESTREAMS_URL` | `https://kick.com/stream/featured-livestreams/` | The URL for featured livestreams.                |
| `CACHE_TYPE`                    | `SimpleCache`                               | The type of cache to use.                        |
| `CACHE_DEFAULT_TIMEOUT`         | `300`                                       | The default cache timeout in seconds.            |
| `LIVE_CACHE_DURATION_SECONDS`   | `30`                                        | The cache duration for live stream data.         |
| `VOD_CACHE_DURATION_SECONDS`    | `300`                                       | The cache duration for VOD data.                 |

## Docker

### Building the Image

You can build the Docker image using the following command:

```bash
docker build -t kick-api:latest .
```

### Running with Docker Compose

The easiest way to run the application is with Docker Compose:

```bash
docker-compose up --build
```

### Running with Docker

You can also run the application with a `docker run` command:

```bash
docker run -d \
    --name kick-api \
    --restart unless-stopped \
    -p 8081:8081 \
    kick-api:latest
```

## Troubleshooting

| Symptom                       | Fix                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `403 Forbidden` from Kick     | Verify Cloudscraper patch is active (log shows `sitecustomize:` line). Check outbound network; try disabling IPv6. |
| `gunicorn: command not found` | Ensure `gunicorn` is in `requirements.txt` and Docker image rebuilt without cache.                                 |
| Container exits immediately   | Run `docker logs kick-api` for traceback; missing deps or port clash.                                              |

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
