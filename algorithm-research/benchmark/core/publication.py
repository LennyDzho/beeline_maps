"""Research-only atomic publication harness, never connected to the MVP DB."""
import json
import sqlite3


class StalePlanError(RuntimeError): pass


class PlanStore:
    def __init__(self):
        self.connection=sqlite3.connect(":memory:")
        self.connection.execute("CREATE TABLE division(id TEXT PRIMARY KEY, version INTEGER NOT NULL, plan TEXT NOT NULL)")

    def seed(self,division_id,version,plan):
        self.connection.execute("INSERT INTO division VALUES(?,?,?)",(division_id,version,json.dumps(plan)))
        self.connection.commit()

    def snapshot(self):
        return {d:{"version":v,"plan":json.loads(p)} for d,v,p in self.connection.execute("SELECT id,version,plan FROM division")}

    def publish(self,plans,expected_versions):
        if set(plans)!=set(expected_versions): raise ValueError("Every participating division needs an expected version")
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            for division,expected in expected_versions.items():
                row=self.connection.execute("SELECT version FROM division WHERE id=?",(division,)).fetchone()
                if row is None or row[0]!=expected: raise StalePlanError(division)
            for division,plan in plans.items():
                self.connection.execute("UPDATE division SET version=version+1,plan=? WHERE id=?",(json.dumps(plan),division))
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
