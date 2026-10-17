"""Single table adapter: CAS metadata, sample rows, immutable event batches and global IDs.

An event batch uses at most 62 transaction actions (60 identities + batch + metadata).
No scan is needed for a user's session list. DynamoDB Local uses the same adapter.
"""
import json
from uuid import uuid4

import boto3
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

from .contracts import canonical
from .errors import ApiError


class DynamoRepository:
    def __init__(self, table_name, endpoint=None):
        self.resource = boto3.resource("dynamodb", endpoint_url=endpoint)
        self.client = boto3.client("dynamodb", endpoint_url=endpoint)
        self.table = self.resource.Table(table_name)
        self.serializer = TypeSerializer()

    def wire(self, item):
        return {k: self.serializer.serialize(v) for k, v in item.items()}

    def get(self, pk, sk):
        return self.table.get_item(Key={"pk": pk, "sk": sk}, ConsistentRead=True).get("Item")

    def query(self, pk, prefix=""):
        args = {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix), "ConsistentRead": True}
        items = []
        while True:
            page = self.table.query(**args)
            items.extend(page["Items"])
            if "LastEvaluatedKey" not in page:
                return items
            args["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def put_action(self, item, condition="attribute_not_exists(pk)", **kwargs):
        return {"Put": {"TableName": self.table.name, "Item": self.wire(item), "ConditionExpression": condition, **kwargs}}

    def transact(self, actions):
        try:
            self.client.transact_write_items(TransactItems=actions)
        except ClientError as exc:
            if exc.response["Error"]["Code"] in {"TransactionCanceledException", "ConditionalCheckFailedException"}:
                raise ApiError(409, "concurrent_write", "이미 사용된 식별자이거나 기록이 변경되었습니다.") from None
            raise ApiError(503, "storage_unavailable", "저장소 연결을 다시 시도해 주세요.") from None

    def create(self, owner, key, payload, record):
        pk = "owner#" + owner
        matches = [self.get(pk, "client#" + payload["client_session_id"]), self.get(pk, "idem#" + key)]
        ids = {item["session_id"] for item in matches if item}
        if ids:
            if len(ids) != 1:
                raise ApiError(409, "idempotency_conflict", "시작 식별자가 충돌합니다.")
            try:
                existing = self.load(owner, ids.pop())
            except ApiError:
                raise ApiError(409, "deleted_session", "이미 삭제된 시작 식별자입니다.") from None
            if existing["create"] != payload:
                raise ApiError(409, "idempotency_conflict", "시작 요청 내용이 다릅니다.")
            return existing
        session_id = record["session"]["id"]
        self.transact([
            self.put_action({"pk": pk, "sk": "session#" + session_id, "body": canonical(record), "revision": 0}),
            self.put_action({"pk": pk, "sk": "client#" + payload["client_session_id"], "session_id": session_id}),
            self.put_action({"pk": pk, "sk": "idem#" + key, "session_id": session_id}),
        ])
        return record

    def load(self, owner, session_id):
        meta = self.get("owner#" + owner, "session#" + session_id)
        if not meta or meta.get("deleted"):
            raise ApiError(404, "not_found", "기록을 찾을 수 없습니다.")
        record = json.loads(meta["body"])
        record["samples"], record["events"] = {}, {}
        for item in self.query("session#" + session_id):
            body = json.loads(item["body"])
            if item["sk"].startswith("sample#"):
                record["samples"][body["seq"]] = body
            elif item["sk"].startswith("event-batch#"):
                record["events"].update({e["event_seq"]: e for e in body})
        # Metadata may change while querying rows; never commit an inconsistent snapshot.
        fresh = self.get("owner#" + owner, "session#" + session_id)
        if not fresh or fresh.get("deleted"):
            raise ApiError(404, "not_found", "기록을 찾을 수 없습니다.")
        if fresh["revision"] != meta["revision"]:
            raise ApiError(409, "concurrent_write", "기록이 변경되었습니다. 다시 시도해 주세요.")
        return record

    def list(self, owner):
        return [json.loads(item["body"])["session"] for item in self.query("owner#" + owner, "session#") if not item.get("deleted")]

    def commit(self, owner, record, samples=(), events=()):
        session_id, revision = record["session"]["id"], record["revision"]
        stored = {k: v for k, v in record.items() if k not in {"samples", "events"}}
        stored["revision"] = revision + 1
        actions = [self.put_action({"pk": "owner#" + owner, "sk": "session#" + session_id,
                                    "body": canonical(stored), "revision": revision + 1},
                                   "revision = :revision AND attribute_not_exists(deleted)",
                                   ExpressionAttributeValues={":revision": {"N": str(revision)}})]
        for sample in samples:
            actions.append(self.put_action({"pk": "session#" + session_id, "sk": f"sample#{sample['seq']:012d}", "body": canonical(sample)}))
        if events:
            actions.append(self.put_action({"pk": "session#" + session_id, "sk": "event-batch#" + str(uuid4()), "body": canonical(list(events))}))
            for event in events:
                actions.append(self.put_action({"pk": "event#" + event["event_id"], "sk": "identity", "session_id": session_id}))
        self.transact(actions)

    def delete(self, owner, session_id):
        pk, sk = "owner#" + owner, "session#" + session_id
        meta = self.get(pk, sk)
        if not meta:
            return
        if not meta.get("deleted"):
            self.transact([self.put_action({"pk": pk, "sk": sk, "body": "{}", "deleted": True,
                                           "revision": int(meta["revision"]) + 1},
                                          "revision = :revision",
                                          ExpressionAttributeValues={":revision": {"N": str(meta["revision"])}})])
        # Tombstone blocks writers before chunked deletion; a retry finishes interrupted cleanup.
        rows = self.query("session#" + session_id)
        with self.table.batch_writer() as writer:
            for row in rows:
                if row["sk"].startswith("event-batch#"):
                    for event in json.loads(row["body"]):
                        writer.delete_item(Key={"pk": "event#" + event["event_id"], "sk": "identity"})
                writer.delete_item(Key={"pk": row["pk"], "sk": row["sk"]})
