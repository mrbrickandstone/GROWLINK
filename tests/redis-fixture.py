"""Disposable Redis/Lua contract fixture. Optional: pip install 'fakeredis[lua]'."""
import json
import sys
import fakeredis

db = fakeredis.FakeRedis(decode_responses=True)
for line in sys.stdin:
    try:
        command = json.loads(line)
        result = db.execute_command(*command)
        if command[0].upper() == 'SET' and result is True:
            result = 'OK'
        print(json.dumps({'result': result}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
