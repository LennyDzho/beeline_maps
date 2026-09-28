"""BK-scoped HD competencies, inferred only from observed assignments.

The adapter wire format uses qualification tokens to express conjunctions in
every existing backend. These are skill constraints, not invented equipment.
"""
import json


def normalize_hd(value):
    if value == "Заказ подключения/Дозаказ оборудования":
        return ["Заявка на подключение", "Дозаказ оборудования"]
    return ["Заявка на подключение" if value == "Заказ подключения" else value]


def token(bk, hd):
    return "hd:" + json.dumps([bk, hd], ensure_ascii=False, separators=(",", ":"))


def required_tokens(job):
    return {token(job["bkType"], hd) for hd in job.get("requiredHdTypes", [])}


def supported_tokens(worker):
    return {token(bk, hd) for bk, types in worker.get("supportedHdTypes", {}).items() for hd in types}
