"""Reproduce explicit address review decisions from cached 2GIS and OSM evidence."""
import json
from pathlib import Path
from prepare_geodata import save

ROOT = Path(__file__).resolve().parents[1]


def main():
    osm = json.loads((ROOT / "matrices/osm-geocoding-review.json").read_text(encoding="utf-8"))
    objects = json.loads((ROOT / "matrices/osm-routing-address-probe.json").read_text(encoding="utf-8"))["elements"]
    two = json.loads((ROOT / "matrices/geocoding.json").read_text(encoding="utf-8"))
    decisions = {}

    def nom(address, oid, reason, assumption=False, query=None):
        item = next(item for item in osm[query or address]["candidates"] if item["osm_id"] == oid)
        decisions[address] = {"sourceAddress": address, "matchedAddress": item["display_name"], "provider": "OSM/Nominatim",
            "providerId": f"{item['osm_type']}/{oid}", "point": {"lat": float(item["lat"]), "lon": float(item["lon"])},
            "isAssumption": assumption, "reason": reason, "evidence": f"https://www.openstreetmap.org/{item['osm_type']}/{oid}",
            "cache": "matrices/osm-geocoding-review.json"}

    def obj(address, oid, reason, use_two_point=False):
        item = next(item for item in objects if item["id"] == oid)
        point = item["center"]
        if use_two_point:
            point = two[address]["candidates"][0]["point"]
        decisions[address] = {"sourceAddress": address,
            "matchedAddress": item["tags"]["addr:street"] + ", " + item["tags"]["addr:housenumber"],
            "provider": "2gis corroborated by OSM" if use_two_point else "OSM/Overpass", "providerId": f"{item['type']}/{oid}",
            "point": point, "isAssumption": True, "reason": reason,
            "evidence": f"https://www.openstreetmap.org/{item['type']}/{oid}", "cache": "matrices/osm-routing-address-probe.json"}

    nom("Москва, проезд Орехово-Зуевский, д. 18/8", 45897230, "OSM содержит точный составной номер 18/8 и ту же улицу.")
    nom("Город Москва, ул.Талалихина, д. 16", 50286450, "Точный адрес; выбран Таганский район, указанный в исходной заявке, а не Липки/Щербинка.")
    nom("г.Город Москва, наб.Семеновская, д. 2/1", 48899469, "OSM содержит точный номер 2/1 без добавления строения.")
    nom("Кашира, ул.Садовая, д. 18", 106326960, "Точный адрес и город; выбран контур здания, остальные результаты OSM — точки услуг внутри него.")
    nom("Кашира, ул.8 Марта, д. 22", 302388031, "Точный номер 22 в Кашире-2; альтернативный объект имеет номер 22/2. Нормализация 8 Марта / 8-го Марта.",
        query="Кашира-2, улица 8 Марта, 22")
    nom("Москва Бирюлевская ул. д. 44", 32632061, "Адресное допущение: неполный номер 44 сопоставлен с 44/6; оба провайдера находят это здание.", True)
    obj("МО, г. Кашира Кржижановского ул. д. 5/1", 106326979,
        "Адресное допущение: 5/1 трактуется как 5 к1, согласно 2ГИС и OSM. В OSM два контура 5 к1 рядом; сохранена точка 2ГИС на северном контуре, без выдуманного уточнения подъезда.", True)
    obj("МО, г. Кашира Кржижановского ул. д. 5/2", 106326943,
        "Адресное допущение: 5/2 трактуется как 5 к2; оба провайдера находят соответствующий корпус.")
    obj("МО, г. Кашира Кржижановского ул. д. 5/3", 106326939,
        "Адресное допущение: 5/3 трактуется как 5 к3; оба провайдера находят соответствующий корпус.")
    obj("г. Москва, ул Юных Ленинцев, д 83с 4", 85397778,
        "Модельный старт: с4 в исходнике заменено на к4 только для эксперимента. Оба провайдера находят 83 к4; фактический офис не подтверждён.")
    obj("г. Москва, ул Бирюлёвская, д 1с1", 28456829,
        "Модельный старт: с1 в исходнике заменено на к1 только для эксперимента. Оба провайдера находят 1 к1; фактический офис не подтверждён.")
    obj("Город Москва, ул.Дубининская, д. 59 к 2", 118566367,
        "Синтетическая точка: 59 к2 не найдено. Использован существующий дом 59 на той же улице; это не подтверждённый адрес заявки. Кандидат 2ГИС 57Б не принят как эквивалент.")
    save(ROOT / "matrices/geocoding-resolutions.json", decisions)
    lines = ["# Адресная проверка: 2ГИС и OSM", "",
        "Исходные адреса сохранены. Из 12 спорных уникальных адресов пять сопоставлены по точному номеру/контексту, семь требуют явных допущений. Повторяющийся 5/1 относится к двум заявкам. Два допущения задают старт 24 исполнителям.", "",
        "Смена 09:00–22:00, автомобиль и отсутствие перерывов относятся к тестовому сценарию. Адресные допущения также относятся только к исследовательскому набору, а не к реальным данным кейсодателя. Для точных операционных маршрутов их надо подтвердить.", "",
        "Данные OSM: [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright). Запросы Nominatim выполнялись однократно, последовательно с кешированием и паузой >1 с, согласно [политике](https://operations.osmfoundation.org/policies/nominatim/).", "",
        "| Исходный адрес | Выбранный объект | Статус | Основание |", "|---|---|---|---|"]
    for source, decision in decisions.items():
        lines.append(f"| {source} | [{decision['matchedAddress']}]({decision['evidence']}) | {'Допущение' if decision['isAssumption'] else 'Адрес подтверждён'} | {decision['reason']} |")
    lines += ["", "JSON с координатами, источниками и причинами: `matrices/geocoding-resolutions.json`. Число возвращённых кандидатов не считается доказательством правильного адреса. Первые результаты геокодера автоматически не принимаются.", ""]
    (ROOT / "reports/GEOCODING_REVIEW.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"Recorded {len(decisions)} decisions, {sum(x['isAssumption'] for x in decisions.values())} declared assumptions")


if __name__ == "__main__":
    main()
