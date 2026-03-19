from flask import request
from flask_restx import Namespace, Resource, fields
from services.chromecast_service import chromecast_service
from helpers.response_helper import success_response, error_response
from helpers.error_handlers import handle_chromecast_errors
import logging

logger = logging.getLogger(__name__)

ns = Namespace('chromecast', description='Chromecast operations')

device_model = ns.model('Device', {
    'name': fields.String(required=True, description='Friendly name of the Chromecast device'),
    'uuid': fields.String(required=True, description='Unique identifier of the Chromecast device'),
})

select_device_parser = ns.parser()
select_device_parser.add_argument('uuid', type=str, required=True, help='UUID of the Chromecast device to select', location='json')

cast_stream_parser = ns.parser()
cast_stream_parser.add_argument('stream_url', type=str, required=True, help='URL of the stream to cast', location='json')
cast_stream_parser.add_argument('title', type=str, required=False, help='Title of the stream (defaults to "Kick Stream")', default='Kick Stream', location='json')

@ns.route('/devices')
class ChromecastDevices(Resource):
    @ns.doc('list_chromecast_devices')
    @handle_chromecast_errors
    def get(self):
        """
        Returns available Chromecast devices from cache and triggers background refresh.
        Returns instantly with cached data; fresh data available on next request.
        """
        logger.info("Received request to discover Chromecast devices.")
        force = request.args.get('force', 'false').lower() == 'true'

        # Return cached devices immediately, trigger background scan if stale
        scanning = chromecast_service.scan_for_devices_async(force=force)
        devices = chromecast_service.get_devices()

        logger.info(f"Returning {len(devices)} devices (background scan: {scanning}).")
        return success_response(data={
            'devices': devices,
            'scanning': scanning or chromecast_service.is_scanning()
        })

@ns.route('/select')
class ChromecastSelect(Resource):
    @ns.doc('select_chromecast_device')
    @ns.expect(select_device_parser)
    @handle_chromecast_errors
    def post(self):
        """
        Selects a Chromecast device to cast to.
        """
        data = request.get_json()
        uuid = data.get('uuid')
        if not uuid:
            return error_response('Device UUID is required.', 400)

        logger.info(f"Received request to select Chromecast device: {uuid}")
        success, reason = chromecast_service.select_device_with_timeout(uuid, timeout=15)
        if success:
            return success_response(message=f'Device {uuid} selected.')
        elif reason == 'scanning':
            return error_response('Device scan in progress. Please wait and try again.', 409)
        elif reason == 'busy':
            return error_response('Another device selection is in progress.', 409)
        else:
            return error_response(f'Device {uuid} not found or connection failed.', 404)

@ns.route('/cast')
class ChromecastCast(Resource):
    @ns.doc('cast_stream_to_chromecast')
    @ns.expect(cast_stream_parser)
    @handle_chromecast_errors
    def post(self):
        """
        Casts a stream to the selected Chromecast device.
        """
        data = request.get_json()
        stream_url = data.get('stream_url')
        title = data.get('title', 'Kick Stream')

        if not stream_url:
            return error_response('Stream URL is required.', 400)

        logger.info(f"Received request to cast stream: {stream_url}")
        if chromecast_service.cast_stream(stream_url, title):
            return success_response(message='Casting started.')
        else:
            return error_response('Failed to start casting.', 500)

stop_cast_parser = ns.parser()
stop_cast_parser.add_argument('uuid', type=str, required=False, help='UUID of the Chromecast device to stop/disconnect', location='json')

@ns.route('/stop')
class ChromecastStop(Resource):
    @ns.doc('stop_chromecast_cast')
    @ns.expect(stop_cast_parser)
    @handle_chromecast_errors
    def post(self):
        """
        Stops the current cast or disconnects a specific device.
        """
        data = request.get_json(silent=True)
        if request.content_length and not data:
            logger.warning("Malformed JSON in /stop request body.")
        uuid = data.get('uuid') if data else None

        logger.info(f"Received request to stop casting (UUID: {uuid if uuid else 'None'}).")
        if chromecast_service.stop_cast(uuid):
            return success_response(message='Cast stopped.')
        else:
            return error_response('Failed to stop cast. No device was selected or the specified UUID was not found.', 404)

@ns.route('/last-device')
class ChromecastLastDevice(Resource):
    @ns.doc('get_last_chromecast_device')
    @handle_chromecast_errors
    def get(self):
        """
        Returns the last successfully connected Chromecast device UUID and name.
        Used by the frontend to offer a one-click reconnect after disconnect.
        """
        device = chromecast_service.get_last_device()
        return success_response(data={'device': device})

@ns.route('/status')
class ChromecastStatus(Resource):
    @ns.doc('get_chromecast_status')
    @handle_chromecast_errors
    def get(self):
        """
        Returns the current status of the Chromecast connection.
        """
        status = chromecast_service.get_status()
        return success_response(data=status)
