def handler(request):
    import json
    body = json.dumps({"status": "ok", "message": "TriTrain backend fonctionne !"})
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": body
    }
