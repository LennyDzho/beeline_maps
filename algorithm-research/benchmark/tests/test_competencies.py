"""Regression for conjunctions and exact BK scoping, independent of solvers."""
import copy
import sys
import unittest
from pathlib import Path
sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parents[1]/"scripts")]
from core.competencies import normalize_hd,token
from core.preflight import check_problem
from core.validator import validate
from run_regression_matrix import base


class CompetencyTests(unittest.TestCase):
    def test_combined_work_is_one_conjunction_not_slash_split(self):
        self.assertEqual(normalize_hd("Заказ подключения/Дозаказ оборудования"),["Заявка на подключение","Дозаказ оборудования"])
        self.assertEqual(normalize_hd("TVE/ENT. Плохое качество картинки"),["TVE/ENT. Плохое качество картинки"])

    def test_missing_second_hd_and_wrong_bk_rejected_independently(self):
        p,s=base(); j=p["jobs"][0];w=p["workers"][0]
        j.update(bkType="bk-a",requiredHdTypes=["one","two"])
        w["supportedHdTypes"]={"bk-a":["one"],"bk-b":["one","two"]}
        self.assertGreater(validate(p,s)["H03"],0)
        w["supportedHdTypes"]["bk-a"].append("two")
        self.assertEqual(validate(p,s)["totalHardViolations"],0)

    def test_preflight_rejects_wrong_adapter_encoding(self):
        p,_=base();p["competencyModel"]="bk-scoped-hd-v2";j=p["jobs"][0];w=p["workers"][0]
        j.update(bkType="bk",requiredHdTypes=["one","two"],requiredQualifications=[token("bk","one")])
        w.update(supportedHdTypes={"bk":["one"]},qualifications=[token("bk","one"),token("bk","two")])
        codes={x["code"] for x in check_problem(p)["issues"]}
        self.assertTrue({"HD_JOB_ENCODING","HD_WORKER_ENCODING"}<=codes)


if __name__=="__main__":unittest.main()
