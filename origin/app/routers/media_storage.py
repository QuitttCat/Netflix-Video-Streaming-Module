from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile

from ..services.s3_media import (
    S3MediaService,
    build_media_key,
    is_s3_error,
)

router = APIRouter()


def get_s3_service() -> S3MediaService:
    svc = S3MediaService()
    missing = svc.validate_configuration()
    if missing:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "S3 is not configured",
                "missing": missing,
            },
        )
    return svc


@router.get("/s3/health")
async def s3_health_check():
    svc = get_s3_service()
    try:
        svc.check_bucket_access()
        return {
            "ok": True,
            "bucket": svc.bucket_name,
            "region": svc.region,
        }
    except Exception as exc:
        if is_s3_error(exc):
            raise HTTPException(status_code=502, detail=f"S3 access failed: {str(exc)}")
        raise


@router.post("/s3/upload")
async def upload_to_s3(
    file: UploadFile = File(...),
    media_type: str = Form(...),
    owner_id: str = Form("common"),
):
    svc = get_s3_service()
    key = build_media_key(media_type=media_type, owner_id=owner_id, file_name=file.filename)

    try:
        data = await file.read()
        content_type = file.content_type or "application/octet-stream"
        result = svc.upload_bytes(key=key, data=data, content_type=content_type)
        return {
            "ok": True,
            "media_type": media_type,
            "owner_id": owner_id,
            "content_type": content_type,
            **result,
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        if is_s3_error(exc):
            raise HTTPException(status_code=502, detail=f"S3 upload failed: {str(exc)}")
        raise


@router.post("/s3/presign-upload")
async def presign_upload(
    media_type: str = Form(...),
    owner_id: str = Form("common"),
    file_name: str = Form(...),
    content_type: str = Form("application/octet-stream"),
    expires_in_seconds: int = Form(3600),
):
    svc = get_s3_service()
    try:
        key = build_media_key(media_type=media_type, owner_id=owner_id, file_name=file_name)
        url = svc.generate_presigned_upload_url(
            key=key,
            content_type=content_type,
            expires_in_seconds=expires_in_seconds,
        )
        return {
            "ok": True,
            "key": key,
            "bucket": svc.bucket_name,
            "upload_url": url,
            "public_url": svc.object_url(key),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        if is_s3_error(exc):
            raise HTTPException(status_code=502, detail=f"Presign upload failed: {str(exc)}")
        raise


@router.get("/s3/presign-download")
async def presign_download(
    key: str = Query(...),
    expires_in_seconds: int = Query(3600),
):
    svc = get_s3_service()
    try:
        url = svc.generate_presigned_download_url(key=key, expires_in_seconds=expires_in_seconds)
        return {
            "ok": True,
            "key": key,
            "bucket": svc.bucket_name,
            "download_url": url,
        }
    except Exception as exc:
        if is_s3_error(exc):
            raise HTTPException(status_code=502, detail=f"Presign download failed: {str(exc)}")
        raise


@router.get("/s3/object")
async def get_s3_object_head(key: str = Query(...)):
    svc = get_s3_service()
    try:
        head = svc.head_object(key=key)
        return {
            "ok": True,
            "bucket": svc.bucket_name,
            "key": key,
            "size": head.get("ContentLength"),
            "content_type": head.get("ContentType"),
            "etag": head.get("ETag"),
            "last_modified": head.get("LastModified"),
        }
    except Exception as exc:
        if is_s3_error(exc):
            raise HTTPException(status_code=404, detail=f"Object not found or inaccessible: {str(exc)}")
        raise
