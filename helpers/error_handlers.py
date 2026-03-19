from functools import wraps
from flask import current_app as app
import requests
import re
from helpers.response_helper import error_response

def handle_kick_api_errors(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        channel_slug = kwargs.get('channel_slug') or kwargs.get('vod_id') or f.__qualname__
        # Sanitize slug for safe logging
        safe_slug = re.sub(r'[^a-zA-Z0-9_\-.]', '_', str(channel_slug)) if channel_slug else "unknown"

        try:
            return f(*args, **kwargs)
        except requests.exceptions.HTTPError as http_err:
            status_code = http_err.response.status_code
            if status_code == 404:
                app.logger.warning(f"Kick channel '{safe_slug}' not found (404).")
                return error_response(f"Kick channel '{safe_slug}' not found.", 404)
            app.logger.error(f"HTTP error for '{safe_slug}': {http_err}", exc_info=True)
            return error_response("Failed to fetch data from streaming service.", status_code)
        except requests.exceptions.RequestException as req_err:
            app.logger.error(f"Request exception for '{safe_slug}': {req_err}", exc_info=True)
            return error_response("Error communicating with streaming service.", 500)
        except Exception as e:
            app.logger.error(f"Unexpected error for '{safe_slug}': {e}", exc_info=True)
            return error_response("An internal server error occurred.", 500)
    return decorated_function

def handle_chromecast_errors(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except Exception as e:
            app.logger.error(f"Chromecast error: {e}", exc_info=True)
            return error_response("An internal server error occurred.", 500)
    return decorated_function
