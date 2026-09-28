package ru.mmi.marshrut

import org.junit.Assert.assertEquals
import org.junit.Test
import ru.mmi.marshrut.core.model.RequiredEquipment
import ru.mmi.marshrut.core.model.regionalInterval
import ru.mmi.marshrut.core.model.DatasetRules

class RegionalVisitDetailsTest {
    @Test fun cachedCommandsNeverCrossDatasetNamespaces() {
        assertEquals(false, DatasetRules.changed(null, "legacy"))
        assertEquals(false, DatasetRules.changed("", "null"))
        assertEquals(true, DatasetRules.changed(null, "beeline-app-v1"))
        assertEquals(true, DatasetRules.changed("beeline-app-v1", "beeline-app-v2"))
        assertEquals(false, DatasetRules.changed("beeline-app-v1", "beeline-app-v1"))
    }
    @Test fun midnightWindowShowsBothDates() {
        assertEquals("17.08 00:00 – 18.08 00:00", regionalInterval("2026-08-17T00:00", "2026-08-18T00:00"))
        assertEquals("09:00 – 10:10", regionalInterval("2026-08-17T09:00", "2026-08-17T10:10"))
        assertEquals("09:00", regionalInterval("2026-08-17T09:00", "null"))
        assertEquals("Не задано", regionalInterval("null", "null"))
    }
    @Test fun equipmentDoesNotInventUnknownQuantityOrUsage() {
        assertEquals("Количество не задано · способ использования не задан", RequiredEquipment("E", "Тестер", null, "шт.", "unspecified").description)
        assertEquals("20 м · расходуемое", RequiredEquipment("C", "Кабель", 20.0, "м", "consumable").description)
        assertEquals("1 шт. · многоразовое", RequiredEquipment("T", "Тестер", 1.0, "шт.", "reusable").description)
    }
}
