import os
from pathlib import Path
import json

def _cred(name, secrets_dir=None):
    if name in os.environ:
        return os.environ[name]
    if secrets_dir:
        p = Path(secrets_dir)
        exact = p / name
        if exact.is_file():
            return exact.read_text().strip()
        for envf in p.glob("*.env"):
            if not envf.is_file():
                continue
            for line in envf.read_text().splitlines():
                line = line.strip()
                if line.startswith(name + "="):
                    val = line.split("=", 1)[1].strip().strip('"\'').strip()
                    if val:
                        return val
        for jsonf in p.glob("*.json"):
            if not jsonf.is_file():
                continue
            try:
                data = json.loads(jsonf.read_text())
                if isinstance(data, dict) and name in data and data[name]:
                    return str(data[name]).strip()
            except Exception:
                continue
    try:
        from google.colab import userdata
        try:
            return userdata.get(name)
        except Exception:
            pass
    except Exception:
        pass
    raise RuntimeError(f"missing {name}")

def client(secrets_dir=None):
    import boto3
    for v in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        if not _cred(v, secrets_dir):
            raise RuntimeError(f"missing {v}")
    account = _cred("R2_ACCOUNT_ID", secrets_dir)
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=_cred("R2_ACCESS_KEY_ID", secrets_dir),
        aws_secret_access_key=_cred("R2_SECRET_ACCESS_KEY", secrets_dir),
        region_name="auto",
    )

def make_sink(bucket="staris-gaia-dr3", prefix="v2-dr3/deep/", secrets_dir=None):
    cl = client(secrets_dir)
    from botocore.exceptions import ClientError
    def sink(local_path, relative_name):
        key = (prefix.rstrip("/") + "/" + str(relative_name).lstrip("/")) if relative_name else prefix
        local_path = str(local_path)
        local_size = Path(local_path).stat().st_size
        try:
            head = cl.head_object(Bucket=bucket, Key=key)
            if head.get("ContentLength") == local_size:
                return key
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey") or "NotFound" in str(e):
                pass
            else:
                raise
        except Exception as e:
            if any(x in str(e) for x in ["404", "NoSuchKey", "NotFound"]):
                pass
            else:
                raise
        cl.upload_file(
            local_path,
            bucket,
            key,
            ExtraArgs={
                "ContentType": "application/octet-stream",
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        return key
    return sink

def upload_file(path, key, bucket="staris-gaia-dr3", content_type=None, cache_control="public, max-age=300", secrets_dir=None):
    cl = client(secrets_dir)
    if content_type is None:
        if str(path).lower().endswith(".json"):
            content_type = "application/json"
        else:
            content_type = "application/octet-stream"
    cl.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": content_type,
            "CacheControl": cache_control,
        },
    )

def object_exists(key, size=None, bucket="staris-gaia-dr3", secrets_dir=None):
    cl = client(secrets_dir)
    try:
        resp = cl.head_object(Bucket=bucket, Key=key)
        if size is not None:
            return resp.get("ContentLength") == size
        return True
    except Exception as e:
        if any(x in str(e) for x in ["404", "NoSuchKey", "NotFound"]):
            return False
        raise
    return False
