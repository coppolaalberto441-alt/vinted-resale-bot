"""GitHub-only consumer. No photo, Telegram token or chat ID in Actions output."""
import json
import os
import urllib.error
import urllib.request


def api(path, *, job=None, data=None, content_type='application/json'):
    base = os.environ['WORKER_URL'].strip().rstrip('/')
    if not base.startswith('https://'):
        raise ValueError('HTTPS required')
    headers = {'Authorization': 'Bearer ' + os.environ['INGEST_SECRET'].strip(), 'Content-Type': content_type}
    if job:
        path += '?id=' + job['id']
        headers['x-cover-lease'] = job['lease']
    request = urllib.request.Request(base+path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        result = response.read(8*1024*1024+1)
    if len(result) > 8*1024*1024:
        raise ValueError('Response too large')
    return result


def main():
    if os.environ.get('GITHUB_REPOSITORY_VISIBILITY') != 'public':
        raise SystemExit('Cover processing requires a public repository and standard free runner')
    from cover_processor import process_bytes
    session = None
    for _ in range(10):
        job = json.loads(api('/cover-jobs/claim',data=b'{}'))['job']
        if not job:
            print('Cover queue empty')
            return
        try:
            if session is None:
                from rembg import new_session
                session=new_session('isnet-general-use',providers=['CPUExecutionProvider'])
            result, _report = process_bytes(api('/cover-jobs/image',job=job),session)
        except Exception:
            # Never print exception payloads: they can contain request headers/URLs.
            print('Cover not reliable/available; requesting original fallback')
            api('/cover-jobs/result',job=job,data=b'{}')
            continue
        api('/cover-jobs/result',job=job,data=result,content_type='image/png')
        print('Cover delivered')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Cover connection HTTP {error.code}; original retained. No paid fallback enabled.') from None
    except urllib.error.URLError:
        raise SystemExit('Cover network connection failed; original retained. No paid fallback enabled.') from None
    except Exception as error:
        raise SystemExit(f'Cover workflow failed ({type(error).__name__}); original retained. No paid fallback enabled.') from None
