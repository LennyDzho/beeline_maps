package ru.mmi.marshrut.core.model

/** Older servers and cached snapshots belong to the original demo namespace. */
object DatasetRules {
    fun version(value: String?) = value?.takeIf { it.isNotBlank() && it != "null" } ?: "legacy"
    fun changed(previous: String?, current: String?) = version(previous) != version(current)
}
