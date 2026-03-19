from flask import Flask, render_template, jsonify
import logging
import traceback # Import traceback
import atexit
from werkzeug.exceptions import HTTPException
from routes.stream_routes import ns as stream_ns
from routes.chromecast_routes import ns as chromecast_ns
from config import Config
from flask_restx import Api
from services.cache_service import init_cache
from services.chromecast_service import chromecast_service

app = Flask(__name__)
app.config.from_object(Config)

# Initialize cache
init_cache(app)

# Configure Chromecast service with app config and register shutdown hook
chromecast_service.configure(app.config)
atexit.register(chromecast_service.shutdown)

# Pre-warm Chromecast device cache at startup (non-blocking)
chromecast_service.scan_for_devices_async(force=True)

# Configure logging
logging.basicConfig(level=Config.LOG_LEVEL, format='%(asctime)s - %(levelname)s - %(message)s')

# Define the root route to serve the landing page
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/config/languages')
def get_languages():
    return {
        'languages': app.config['FEATURED_LANGUAGES'],
        'default_language': app.config['DEFAULT_LANGUAGE_CODE']
    }

# Initialize Flask-RESTX Api
api = Api(app, 
          version='1.0', 
          title='Kick Stream Proxy API',
          description='A proxy API for Kick.com live streams and VODs.',
          doc='/docs'
         )

# Register namespaces with Flask-RESTX API
api.add_namespace(stream_ns)
api.add_namespace(chromecast_ns, path='/api/chromecast')

# Global error handler to catch all unhandled exceptions
@app.errorhandler(Exception)
def handle_exception(e):
    # Pass through HTTP errors like 404
    if isinstance(e, HTTPException):
        return e

    # Log the full traceback
    logging.error(f"An unhandled exception occurred: {e}\n{traceback.format_exc()}")
    # Return a generic error response
    return jsonify(status="error", message="An internal server error occurred."), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=Config.PORT, debug=Config.FLASK_DEBUG)
