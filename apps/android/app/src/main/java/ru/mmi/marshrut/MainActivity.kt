package ru.mmi.marshrut

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import ru.mmi.marshrut.ui.MarshrutApp
import ru.mmi.marshrut.ui.theme.MarshrutTheme

class MainActivity : ComponentActivity() {
    private val model: MarshrutViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MarshrutTheme { MarshrutApp(model) } }
    }
}
