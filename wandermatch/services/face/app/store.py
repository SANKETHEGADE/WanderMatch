"""
Per-trip embedding index, in S3-compatible object storage.

Why not Postgres (even with pgvector, which the provided schema enables):
the design doc scopes embeddings as ephemeral and per-trip, deleted with
the trip. Keeping them out of the relational store makes that deletion a
single object delete rather than a cascade you have to get right, and it
keeps biometric-adjacent vectors out of the same backup/replication path
as ordinary trip data. The trade-off is no cross-trip vector search —
which is a feature here, not a limitation.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import urllib.request
from typing import Optional

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

log = logging.getLogger("face.store")

BUCKET = os.getenv("S3_BUCKET", "wandermatch-photos")
PREFIX = os.getenv("FACE_INDEX_PREFIX", "face-index")
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(20 * 1024 * 1024)))


class EmbeddingStore:
    def __init__(self) -> None:
        self.s3 = boto3.client(
            "s3",
            endpoint_url=os.getenv("S3_ENDPOINT", "http://localhost:9000"),
            aws_access_key_id=os.getenv("S3_ACCESS_KEY_ID", "minioadmin"),
            aws_secret_access_key=os.getenv("S3_SECRET_ACCESS_KEY", "minioadmin"),
            region_name=os.getenv("S3_REGION", "us-east-1"),
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )
        self._local_fallback: dict[str, dict] = {}
        self._use_local = os.getenv("FACE_INDEX_LOCAL", "false").lower() == "true"

    # ------------------------------------------------------------------
    def _key(self, trip_id: str) -> str:
        return f"{PREFIX}/{trip_id}/index.json"

    def load_index(self, trip_id: str) -> dict:
        empty = {"faces": {}, "clusters": {}}
        if self._use_local:
            return self._local_fallback.get(trip_id, empty)
        try:
            obj = self.s3.get_object(Bucket=BUCKET, Key=self._key(trip_id))
            return json.loads(obj["Body"].read())
        except ClientError as exc:
            if exc.response["Error"]["Code"] in ("NoSuchKey", "404", "NoSuchBucket"):
                return empty
            raise
        except Exception:
            log.exception("index load failed trip=%s; starting empty", trip_id)
            return empty

    def save_index(self, trip_id: str, index: dict) -> None:
        if self._use_local:
            self._local_fallback[trip_id] = index
            return
        body = json.dumps(index).encode()
        self.s3.put_object(
            Bucket=BUCKET,
            Key=self._key(trip_id),
            Body=body,
            ContentType="application/json",
            # Server-side encryption: these are biometric-adjacent vectors.
            ServerSideEncryption="AES256",
        )

    def purge(self, trip_id: str) -> bool:
        if self._use_local:
            return self._local_fallback.pop(trip_id, None) is not None
        try:
            self.s3.delete_object(Bucket=BUCKET, Key=self._key(trip_id))
            return True
        except ClientError:
            log.exception("purge failed trip=%s", trip_id)
            return False

    # ------------------------------------------------------------------
    def fetch_image(self, base64_data: Optional[str] = None, url: Optional[str] = None) -> bytes:
        if base64_data:
            raw = base64.b64decode(base64_data, validate=True)
            if len(raw) > MAX_IMAGE_BYTES:
                raise ValueError("image exceeds size limit")
            return raw

        if not url:
            raise ValueError("no image source provided")

        # Only presigned URLs from our own object storage are fetched.
        # Accepting arbitrary URLs here would make this service an SSRF
        # proxy sitting on the private network.
        allowed = os.getenv("S3_ENDPOINT", "http://localhost:9000")
        public = os.getenv("S3_PUBLIC_ENDPOINT", allowed)
        if not (url.startswith(allowed) or url.startswith(public)):
            raise ValueError("refusing to fetch image from an untrusted host")

        with urllib.request.urlopen(url, timeout=30) as resp:
            raw = resp.read(MAX_IMAGE_BYTES + 1)
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("image exceeds size limit")
        return raw
