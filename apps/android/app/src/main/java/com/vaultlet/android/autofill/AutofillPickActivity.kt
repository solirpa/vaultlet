package com.vaultlet.android.autofill

import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.view.autofill.AutofillManager
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.vaultlet.android.R
import com.vaultlet.android.store
import com.vaultlet.android.ui.Group
import com.vaultlet.android.ui.GroupDivider
import com.vaultlet.android.ui.ItemRow
import com.vaultlet.android.ui.P
import com.vaultlet.android.ui.SearchBox
import com.vaultlet.android.ui.SectionLabel
import com.vaultlet.android.ui.Type
import com.vaultlet.android.ui.VaultletRoot
import com.vaultlet.android.ui.tag
import com.vaultlet.android.ui.VaultletTheme
import uniffi.vault_ffi.ItemSummary
import uniffi.vault_ffi.Vault

/**
 * Opened from the "Vaultlet" autofill entry: unlock if needed, then pick the login to fill.
 * Logins matching the app or site come first; any login can be chosen (an explicit choice).
 */
class AutofillPickActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // As in MainActivity: no screenshots of secrets, except in debug builds (UI tests).
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE == 0) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        }
        val structure = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE, AssistStructure::class.java)
        } else {
            @Suppress("DEPRECATION") intent.getParcelableExtra(AutofillManager.EXTRA_ASSIST_STRUCTURE)
        }
        val form = structure?.let { parseLoginForm(it) }
        if (form == null) {
            finish()
            return
        }
        setContent {
            VaultletTheme {
                // Setup / unlock screens as in the app, then the picker.
                VaultletRoot(store, this) { s -> Picker(s.vault, form) { item -> fill(s.vault, form, item) } }
            }
        }
    }

    private fun fill(vault: Vault, form: LoginForm, item: ItemSummary) {
        val detail = vault.item(item.id) ?: return
        vault.touch(item.id)
        val result = Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset(this, form, item.title, detail.username, detail.password))
        setResult(RESULT_OK, result)
        finish()
    }
}

@Composable
private fun Picker(vault: Vault, form: LoginForm, onPick: (ItemSummary) -> Unit) {
    var query by remember { mutableStateOf("") }
    var suggested by remember { mutableStateOf<List<ItemSummary>>(emptyList()) }
    var results by remember { mutableStateOf<List<ItemSummary>>(emptyList()) }
    LaunchedEffect(Unit) { suggested = matches(vault, form) }
    LaunchedEffect(query) { results = (if (query.isBlank()) vault.items() else vault.search(query)).filter { it.kind == "login" } }

    // Centred and no wider than a phone on tablets.
    LazyColumn(
        Modifier.fillMaxSize().background(P.bg).wrapContentWidth().widthIn(max = 640.dp).tag("picker_list"),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
    ) {
        item {
            Column(Modifier.statusBarsPadding().padding(top = 16.dp)) {
                Text(stringResource(R.string.autofill_choose), style = Type.title, color = P.text)
                Text(
                    stringResource(R.string.autofill_for, form.webDomain ?: form.packageName),
                    style = Type.subhead, color = P.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 4.dp),
                )
                SearchBox(query, { query = it }, Modifier.padding(top = 16.dp, bottom = 4.dp).tag("picker_search"))
            }
        }
        if (query.isBlank() && suggested.isNotEmpty()) {
            item { SectionLabel(stringResource(R.string.autofill_suggested)) }
            item { Group { suggested.forEachIndexed { i, it -> if (i > 0) GroupDivider(70.dp); ItemRow(it) { onPick(it) } } } }
        }
        item { SectionLabel(stringResource(if (query.isBlank()) R.string.all_items else R.string.results), trailing = "${results.size}") }
        item { Group { results.forEachIndexed { i, it -> if (i > 0) GroupDivider(70.dp); ItemRow(it) { onPick(it) } } } }
    }
}
