package com.vaultlet.android

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.fragment.app.FragmentActivity
import com.vaultlet.android.ui.VaultletRoot
import com.vaultlet.android.ui.VaultletTheme

// FragmentActivity: BiometricPrompt needs one.
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep secrets out of screenshots and the recent-apps preview (debug builds allow them
        // so the UI can be tested).
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        }
        enableEdgeToEdge()
        setContent {
            VaultletTheme {
                VaultletRoot(store, this)
            }
        }
    }
}
