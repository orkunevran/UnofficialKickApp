from flask_caching import Cache

cache = Cache()

def init_cache(app):
    """
    Initializes the cache with the Flask app.
    """
    cache.init_app(app)
