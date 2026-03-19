import re
from flask import redirect, request, current_app as app
from flask_restx import Namespace, Resource, fields, reqparse
from services.kick_api_service import kick_api_client
from helpers.response_helper import success_response, error_response
from services.cache_service import cache
from config import Config
from helpers.error_handlers import handle_kick_api_errors

# Input validation
_SLUG_RE = re.compile(r'^[a-zA-Z0-9_-]{1,255}$')

def _validate_slug(slug):
    """Validate channel_slug against a safe pattern."""
    if not slug or not _SLUG_RE.match(slug):
        return False
    return True

# Define a Namespace for stream-related routes
ns = Namespace('streams', description='Kick Stream Proxy Operations')

# Define models for Swagger documentation
live_stream_model = ns.model('LiveStream', {
    'status': fields.String(required=True, description='Status of the channel (e.g., "live", "offline", "error")'),
    'channel_slug': fields.String(description='The slug (username) of the channel'),
    'followers_count': fields.Integer(description='Number of followers for the channel'),
    'playback_url': fields.String(description='URL for the live stream (present if status is "live")'),
    'livestream_thumbnail_url': fields.String(description='Thumbnail URL of the live stream'),
    'livestream_title': fields.String(description='Title of the current live stream session'),
    'livestream_viewer_count': fields.Integer(description='Current number of viewers for the live stream'),
    'livestream_category': fields.String(description='Category of the current live stream'),
    'error': fields.String(description='Error message if status is "offline" or "error"'),
})

vod_item_model = ns.model('VODItem', {
    'vod_id': fields.Integer(description='Unique ID of the VOD'),
    'video_uuid': fields.String(description='UUID of the video file'),
    'title': fields.String(description='Title of the VOD session'),
    'source_url': fields.String(description='Direct URL to the VOD M3U8 file'),
    'thumbnail_url': fields.String(description='URL to the VOD thumbnail'),
    'views': fields.Integer(description='Number of views for the VOD'),
    'duration_seconds': fields.Float(description='Duration of the VOD in seconds'),
    'created_at': fields.String(description='Timestamp when the VOD was created'),
    'language': fields.String(description='Language of the VOD'),
    'is_mature': fields.Boolean(description='Indicates if the VOD is mature content'),
})

vod_list_model = ns.model('VODList', {
    'vods': fields.List(fields.Nested(vod_item_model), description='List of VODs for the channel'),
})


def _build_channel_profile(data, channel_slug):
    """Extract rich channel profile fields from Kick channel API response."""
    user = data.get("user") or {}
    banner = data.get("banner_image")
    return {
        "channel_slug": channel_slug,
        "username": user.get("username") or channel_slug,
        "profile_picture": user.get("profile_pic"),
        "banner_image_url": banner.get("url") if isinstance(banner, dict) else None,
        "bio": (user.get("bio") or "").strip() or None,
        "followers_count": data.get("followers_count"),
        "verified": bool(data.get("verified")),
        "subscription_enabled": bool(data.get("subscription_enabled")),
        "social_links": {k: user.get(k) or None for k in ("instagram", "twitter", "youtube", "discord", "tiktok")},
        "recent_categories": [
            c["name"] for c in (data.get("recent_categories") or [])
            if isinstance(c, dict) and c.get("name")
        ],
    }


def _get_channel_livestream_data(channel_slug):
    """Helper function to fetch and process livestream data."""
    if not _validate_slug(channel_slug):
        return None, error_response(f"Invalid channel slug: '{channel_slug}'.", 400)

    app.logger.info(f"Fetching live stream data for: {channel_slug}")
    data = kick_api_client.get_channel_data(channel_slug)
    livestream_data = data.get("livestream")

    if livestream_data is None:
        return None, error_response(f"Channel '{channel_slug}' is currently offline.", 404)

    playback_url = data.get("playback_url")
    if not playback_url:
        return None, error_response("Live playback URL not found in API response.", 500)

    thumbnail = livestream_data.get("thumbnail")
    categories = livestream_data.get("categories")
    # Fallback: use channel profile pic if Kick hasn't generated a stream thumbnail yet
    profile_pic = data.get("user", {}).get("profile_pic")

    response_data = {
        "status": "live",
        "channel_slug": channel_slug,
        "followers_count": data.get("followers_count"),
        "playback_url": playback_url,
        "livestream_id": livestream_data.get("id"),
        "livestream_thumbnail_url": (thumbnail.get("url") if thumbnail else None) or profile_pic,
        "livestream_title": livestream_data.get("session_title"),
        "livestream_viewer_count": livestream_data.get("viewer_count"),
        "livestream_category": categories[0].get("name") if categories else None,
    }
    return response_data, None

@ns.route('/play/<string:channel_slug>')
@ns.param('channel_slug', 'The slug (username) of the Kick channel.')
class PlayStream(Resource):
    @ns.response(200, 'Successful retrieval of stream data', live_stream_model)
    @ns.response(404, 'Channel not found', live_stream_model)
    @ns.response(500, 'Internal server error', live_stream_model)
    @handle_kick_api_errors
    @cache.cached(timeout=Config.LIVE_CACHE_DURATION_SECONDS, key_prefix='live:%s')
    def get(self, channel_slug):
        """
        Returns live stream data for a given channel, including full channel profile.
        Returns status="offline" (HTTP 200) for offline channels instead of 404,
        so the frontend can render a rich profile card even when the stream is down.
        """
        if not _validate_slug(channel_slug):
            return error_response(f"Invalid channel slug: '{channel_slug}'.", 400)

        app.logger.info(f"Fetching live stream data for: {channel_slug}")
        data = kick_api_client.get_channel_data(channel_slug)
        profile = _build_channel_profile(data, channel_slug)

        livestream_data = data.get("livestream")

        # Offline — return rich profile, HTTP 200 (was 404 before)
        if livestream_data is None:
            return success_response({**profile, "status": "offline"})

        playback_url = data.get("playback_url")
        if not playback_url:
            return error_response("Live playback URL not found in API response.", 500)

        thumbnail = livestream_data.get("thumbnail")
        categories = livestream_data.get("categories")
        # Fallback: use channel profile pic if Kick hasn't generated a stream thumbnail yet
        profile_pic = data.get("user", {}).get("profile_pic")

        response_data = {
            **profile,
            "status": "live",
            "playback_url": playback_url,
            "livestream_id": livestream_data.get("id"),
            "livestream_thumbnail_url": (thumbnail.get("url") if thumbnail else None) or profile_pic,
            "livestream_title": livestream_data.get("session_title"),
            "livestream_viewer_count": livestream_data.get("viewer_count"),
            "livestream_category": categories[0].get("name") if categories else None,
        }
        return success_response(response_data)

@ns.route('/vods/<string:channel_slug>')
@ns.param('channel_slug', 'The slug (username) of the Kick channel.')
class ListVODs(Resource):
    @ns.doc(description='Returns a JSON list of past videos (VODs) for a given channel.')
    @ns.response(200, 'Successful retrieval of VODs', vod_list_model)
    @ns.response(404, 'VODs list not found')
    @ns.response(500, 'Internal server error')
    @handle_kick_api_errors
    @cache.cached(timeout=Config.VOD_CACHE_DURATION_SECONDS, key_prefix='vods:%s')
    def get(self, channel_slug):
        """
        Returns a JSON list of past videos (VODs) for a given channel.
        """
        if not _validate_slug(channel_slug):
            return error_response(f"Invalid channel slug: '{channel_slug}'.", 400)
        app.logger.info(f"Fetching VODs for: {channel_slug}")
        raw_vod_data_list = kick_api_client.get_channel_videos(channel_slug)
        processed_vods = self._process_vod_data(raw_vod_data_list)
        return success_response({"vods": processed_vods})

    def _process_vod_data(self, vod_data_list):
        if not isinstance(vod_data_list, list):
            return []

        return [
            {
                "vod_id": vod.get("id"),
                "video_uuid": vod.get("video", {}).get("uuid"),
                "title": vod.get("session_title"),
                "source_url": vod.get("source"),
                "thumbnail_url": vod.get("thumbnail", {}).get("src"),
                "views": vod.get("video", {}).get("views"),
                "duration_seconds": vod.get("duration") / 1000.0 if isinstance(vod.get("duration"), (int, float)) else None,
                "created_at": vod.get("created_at"),
                "language": vod.get("language"),
                "is_mature": vod.get("is_mature"),
            }
            for vod in vod_data_list if isinstance(vod, dict)
        ]

@ns.route('/vods/<string:channel_slug>/<int:vod_id>')
@ns.param('channel_slug', 'The slug of the channel.')
@ns.param('vod_id', 'The ID of the VOD.')
class PlayVODByID(Resource):
    @ns.response(307, 'Redirect to VOD URL')
    @ns.response(404, 'VOD not found')
    @ns.response(500, 'Internal server error')
    @handle_kick_api_errors
    @cache.cached(timeout=Config.VOD_CACHE_DURATION_SECONDS, make_cache_key=lambda *args, **kwargs: f"vod:{kwargs.get('channel_slug', '')}:{kwargs.get('vod_id', '')}")
    def get(self, channel_slug, vod_id):
        """
        Redirects to the M3U8 URL of a specific VOD by its ID for a given channel.
        """
        if not _validate_slug(channel_slug):
            return error_response(f"Invalid channel slug: '{channel_slug}'.", 400)

        if vod_id < 0 or vod_id > 2_147_483_647:
            return error_response("Invalid VOD ID.", 400)

        app.logger.info(f"Request to play VOD by ID: {vod_id} for channel: {channel_slug}")

        # Try to get from the existing VODs cache first
        cached_vods_key = f"vods:/streams/vods/{channel_slug}"
        cached_vods = cache.get(cached_vods_key)

        if cached_vods:
            # Use cached VOD list if available
            vod_response = cached_vods
            if isinstance(vod_response, tuple):
                vod_data = vod_response[0].get('data', {}).get('vods', [])
            else:
                vod_data = []
            for vod_item in vod_data:
                if isinstance(vod_item, dict) and vod_item.get("vod_id") == vod_id:
                    source = vod_item.get("source_url")
                    if source:
                        return redirect(source, code=307)

        # Fall back to API call
        raw_vod_data_list = kick_api_client.get_channel_videos(channel_slug)

        # Find the VOD with the matching ID
        found_vod = None
        for vod_item in raw_vod_data_list:
            if isinstance(vod_item, dict) and vod_item.get("id") == vod_id:
                found_vod = vod_item
                break

        if found_vod and found_vod.get("source"):
            app.logger.info(f"Redirecting to VOD source: {found_vod.get('source')}")
            return redirect(found_vod.get("source"), code=307)
        else:
            app.logger.warning(f"VOD with ID {vod_id} not found for channel {channel_slug}")
            return error_response("VOD not found.", 404)

_SUBCATEGORY_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9 &.:_()\-]{0,99}$')

@ns.route('/featured-livestreams')
class FeaturedLivestreams(Resource):
    @ns.response(200, 'Successful retrieval of featured livestreams')
    @ns.response(500, 'Internal server error')
    @handle_kick_api_errors
    @cache.cached(timeout=Config.FEATURED_CACHE_DURATION_SECONDS, query_string=True)
    def get(self):
        """
        Returns a JSON list of featured livestreams for a given language.
        When category filters are provided, returns the broader public livestream
        discovery surface instead of the promoted featured list.
        """
        parser = reqparse.RequestParser()
        parser.add_argument('language', type=str, default='en', help='Language for featured livestreams')
        args = parser.parse_args()
        language = args['language']

        # Validate language against configured list
        valid_codes = [lang['code'] for lang in Config.FEATURED_LANGUAGES]
        if language not in valid_codes:
            language = Config.DEFAULT_LANGUAGE_CODE

        try:
            page = max(1, int(request.args.get('page', 1)))
        except (ValueError, TypeError):
            page = 1

        category = request.args.get('category', '').strip()
        subcategory = request.args.get('subcategory', '').strip()
        subcategories = request.args.get('subcategories', '').strip()
        sort = request.args.get('sort', '').strip().lower()
        strict = request.args.get('strict', '').strip().lower() == 'true'
        if category and not _SUBCATEGORY_RE.match(category):
            category = ''
        if subcategory and not _SUBCATEGORY_RE.match(subcategory):
            subcategory = ''
        if subcategories and not _SUBCATEGORY_RE.match(subcategories):
            subcategories = ''
        if sort not in {'', 'asc', 'desc', 'featured'}:
            sort = ''

        if category or subcategory or subcategories:
            app.logger.info(
                f"Fetching category-filtered livestreams: lang={language}, page={page}, "
                f"category={category!r}, subcategory={subcategory!r}, "
                f"subcategories={subcategories!r}, sort={sort!r}, strict={strict!r}"
            )
            raw = kick_api_client.get_all_livestreams(
                language,
                page,
                category=category,
                subcategory=subcategory,
                subcategories=subcategories,
                sort=sort,
                strict=strict,
            )
        else:
            app.logger.info(f"Fetching featured livestreams for language: {language}, page: {page}")
            raw = kick_api_client.get_featured_livestreams(language, page)

        streams = raw.get('data', [])
        pagination = {
            'current_page': raw.get('current_page', page),
            'per_page': raw.get('per_page', 14),
            'has_next': raw.get('next_page_url') is not None,
            'has_prev': raw.get('prev_page_url') is not None,
        }
        resp_dict, status = success_response(streams)
        resp_dict['pagination'] = pagination
        return resp_dict, status

@ns.route('/go/<string:channel_slug>')
@ns.param('channel_slug', 'The slug (username) of the Kick channel.')
class GoToLiveStream(Resource):
    @ns.response(307, 'Redirect to live stream URL')
    @ns.response(404, 'Channel offline or not found')
    @ns.response(500, 'Internal server error')
    @handle_kick_api_errors
    @cache.cached(timeout=Config.LIVE_CACHE_DURATION_SECONDS, key_prefix='live_redirect:%s')
    def get(self, channel_slug):
        """
        Redirects to the live stream URL for a given channel.
        Returns 404 if the channel is offline or not found.
        """
        response_data, error = _get_channel_livestream_data(channel_slug)
        if error:
            return error

        return redirect(response_data["playback_url"], code=307)




@ns.route('/clips/<string:channel_slug>')
@ns.param('channel_slug', 'The slug (username) of the Kick channel.')
class ChannelClips(Resource):
    @ns.response(200, 'Successful retrieval of channel clips')
    @ns.response(404, 'Channel not found')
    @ns.response(500, 'Internal server error')
    @handle_kick_api_errors
    @cache.cached(timeout=Config.VOD_CACHE_DURATION_SECONDS, key_prefix='clips:%s')
    def get(self, channel_slug):
        """
        Returns a list of recent clips for a given channel.
        """
        if not _validate_slug(channel_slug):
            return error_response(f"Invalid channel slug: '{channel_slug}'.", 400)

        app.logger.info(f"Fetching clips for channel: {channel_slug}")
        raw = kick_api_client.get_channel_clips(channel_slug)

        # Normalize response shape: {clips: {data: [...]}} or {data: [...]} or [...]
        clip_list = []
        if isinstance(raw, dict):
            clips_obj = raw.get('clips', raw)
            if isinstance(clips_obj, dict):
                clip_list = clips_obj.get('data', [])
            elif isinstance(clips_obj, list):
                clip_list = clips_obj
        elif isinstance(raw, list):
            clip_list = raw

        processed = [
            {
                'clip_id': c.get('id'),
                'title': c.get('title'),
                'clip_url': c.get('clip_url') or c.get('video_url'),
                'thumbnail_url': c.get('thumbnail_url'),
                'duration_seconds': c.get('duration'),
                'views': c.get('views'),
                'category_name': c.get('category', {}).get('name') if isinstance(c.get('category'), dict) else c.get('category'),
                'created_at': c.get('created_at'),
                'channel_slug': c.get('channel', {}).get('slug') if isinstance(c.get('channel'), dict) else channel_slug,
            }
            for c in clip_list if isinstance(c, dict)
        ]
        return success_response({'clips': processed})



@ns.route('/search')
class ChannelSearch(Resource):
    @ns.response(200, 'Search results')
    @ns.response(400, 'Missing or invalid query')
    @handle_kick_api_errors
    @cache.cached(timeout=30, query_string=True)
    def get(self):
        """
        Search Kick channels via Typesense (covers all channels, not just featured).
        Returns live channels sorted by followers, falling back to all channels.
        """
        q = request.args.get('q', '').strip()
        if not q or len(q) < 2:
            return error_response("Query must be at least 2 characters.", 400)
        if len(q) > 100:
            return error_response("Query too long.", 400)

        results = kick_api_client.search_channels_typesense(q)
        return success_response(results)


@ns.route('/avatar/<string:channel_slug>')
@ns.param('channel_slug', 'The slug (username) of the Kick channel.')
class ChannelAvatar(Resource):
    @ns.response(200, 'Channel avatar URL')
    @ns.response(404, 'Channel not found')
    @handle_kick_api_errors
    # Profile pictures almost never change — cache for 7 days to minimise Kick API calls.
    # The lazy-load frontend requests at most 3 of these per search query.
    @cache.cached(timeout=604800, key_prefix='avatar:%s')
    def get(self, channel_slug):
        """
        Returns just the profile picture URL for a channel.
        Cached for 7 days — used by the search dropdown to lazy-load avatars.
        """
        if not _validate_slug(channel_slug):
            return error_response(f"Invalid channel slug: '{channel_slug}'.", 400)
        data = kick_api_client.get_channel_data(channel_slug)
        pic = data.get('user', {}).get('profile_pic')
        return success_response({'profile_picture': pic})


@ns.route('/viewers')
class ViewerCount(Resource):
    @ns.response(200, 'Current viewer count')
    @ns.response(400, 'Missing or invalid livestream ID')
    @ns.response(500, 'Internal server error')
    @handle_kick_api_errors
    @cache.cached(timeout=10, query_string=True)
    def get(self):
        """
        Returns the current viewer count for a given livestream ID.
        """
        try:
            livestream_id = int(request.args.get('id', ''))
        except (ValueError, TypeError):
            return error_response("Missing or invalid livestream ID.", 400)

        if livestream_id <= 0:
            return error_response("Invalid livestream ID.", 400)

        viewers = kick_api_client.get_viewer_count(livestream_id)
        return success_response({'viewer_count': viewers})
