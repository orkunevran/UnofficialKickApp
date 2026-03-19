def success_response(data=None, message="", status_code=200):
    """
    Generates a standardized success dictionary for JSON response.
    """
    response = {
        "status": "success",
        "message": message,
        "data": data if data is not None else {}
    }
    return response, status_code

def error_response(message, status_code):
    """
    Generates a standardized error dictionary for JSON response.
    """
    response = {
        "status": "error",
        "message": message
    }
    return response, status_code
