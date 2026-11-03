import os, time, boto3

client = boto3.client("bedrock-agent")
kb, ds = os.environ["KB_ID"], os.environ["KB_DATA_SOURCE_ID"]

job_id = client.start_ingestion_job(knowledgeBaseId=kb, dataSourceId=ds)["ingestionJob"]["ingestionJobId"]

while True:
    job = client.get_ingestion_job(knowledgeBaseId=kb, dataSourceId=ds, ingestionJobId=job_id)["ingestionJob"]
    print(job["status"], job.get("statistics"))
    if job["status"] in ("COMPLETE", "FAILED", "STOPPED"):
        print(job.get("failureReasons", ""))
        break
    time.sleep(15)
