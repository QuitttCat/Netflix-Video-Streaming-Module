import os
import re
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError


class S3MediaService:
    """Utility service for storing and retrieving media assets in S3."""

    def __init__(self):
        self.region = os.getenv("AWS_REGION", "")
        self.access_key_id = os.getenv("AWS_ACCESS_KEY_ID", "")
        self.secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY", "")
        self.bucket_name = os.getenv("S3_BUCKET_NAME", "")
        self.endpoint_url = os.getenv("S3_ENDPOINT_URL")

        self._s3 = boto3.client(
            "s3",
            region_name=self.region or None,
            aws_access_key_id=self.access_key_id or None,
            aws_secret_access_key=self.secret_access_key or None,
            endpoint_url=self.endpoint_url or None,
        )

    def validate_configuration(self) -> list[str]:
        missing = []
        if not self.region:
            missing.append("AWS_REGION")
        if not self.access_key_id:
            missing.append("AWS_ACCESS_KEY_ID")
        if not self.secret_access_key:
            missing.append("AWS_SECRET_ACCESS_KEY")
        if not self.bucket_name:
            missing.append("S3_BUCKET_NAME")
        return missing

    def check_bucket_access(self) -> bool:
        self._s3.head_bucket(Bucket=self.bucket_name)
        return True

    def upload_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> dict:
        self._s3.put_object(
            Bucket=self.bucket_name,
            Key=key,
            Body=data,
            ContentType=content_type,
        )
        return {
            "bucket": self.bucket_name,
            "key": key,
            "s3_uri": f"s3://{self.bucket_name}/{key}",
            "public_url": self.object_url(key),
        }

    def generate_presigned_upload_url(
        self,
        key: str,
        content_type: str = "application/octet-stream",
        expires_in_seconds: int = 3600,
    ) -> str:
        return self._s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": self.bucket_name,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires_in_seconds,
        )

    def generate_presigned_download_url(self, key: str, expires_in_seconds: int = 3600) -> str:
        return self._s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={
                "Bucket": self.bucket_name,
                "Key": key,
            },
            ExpiresIn=expires_in_seconds,
        )

    def head_object(self, key: str) -> dict:
        return self._s3.head_object(Bucket=self.bucket_name, Key=key)

    def object_url(self, key: str) -> str:
        if self.endpoint_url:
            return f"{self.endpoint_url.rstrip('/')}/{self.bucket_name}/{key}"
        return f"https://{self.bucket_name}.s3.{self.region}.amazonaws.com/{key}"


def normalize_media_type(media_type: str) -> str:
    mt = (media_type or "").strip().lower()
    mapping = {
        "video": "videos",
        "videos": "videos",
        "preview": "previews",
        "previews": "previews",
        "trailer": "trailers",
        "trailers": "trailers",
    }
    if mt not in mapping:
        raise ValueError("media_type must be one of: videos, previews, trailers")
    return mapping[mt]


def sanitize_file_name(file_name: str) -> str:
    name = os.path.basename(file_name or "file.bin")
    name = re.sub(r"\s+", "-", name)
    name = re.sub(r"[^A-Za-z0-9._-]", "", name)
    return name or "file.bin"


def build_media_key(media_type: str, owner_id: str, file_name: str, now: Optional[datetime] = None) -> str:
    mt = normalize_media_type(media_type)
    owner = re.sub(r"[^A-Za-z0-9_-]", "", str(owner_id or "common")) or "common"
    safe_name = sanitize_file_name(file_name)
    timestamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%SZ")
    return f"{mt}/{owner}/{timestamp}-{safe_name}"


def is_s3_error(exc: Exception) -> bool:
    return isinstance(exc, (ClientError, BotoCoreError))
