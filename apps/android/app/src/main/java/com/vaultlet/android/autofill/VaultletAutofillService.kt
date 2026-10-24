package com.vaultlet.android.autofill

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import com.vaultlet.android.R
import com.vaultlet.android.store
import uniffi.vault_ffi.ItemSummary
import uniffi.vault_ffi.Vault

private const val MAX_SUGGESTIONS = 5

/**
 * Offers logins from the vault in other apps and browsers. With the vault unlocked, matching
 * logins are offered directly; otherwise (or for anything else) a "Vaultlet" entry opens
 * [AutofillPickActivity] to unlock and choose.
 */
class VaultletAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val form = parseLoginForm(structure)
        if (form == null || form.packageName == packageName) return callback.onSuccess(null)

        val response = FillResponse.Builder()
        val vault = store.vault
        if (vault != null) {
            for (item in matches(vault, form).take(MAX_SUGGESTIONS)) {
                val detail = vault.item(item.id) ?: continue
                response.addDataset(dataset(this, form, item.title, detail.username, detail.password))
            }
        }
        response.addDataset(pickerDataset(this, form, request.id))
        callback.onSuccess(response.build())
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        callback.onSuccess() // saving from other apps is not offered yet
    }
}

fun matches(vault: Vault, form: LoginForm): List<ItemSummary> =
    form.pageUrl?.let { vault.matches(it) } ?: vault.matchesApp(form.packageName)

private fun presentation(context: Context, title: String, subtitle: String): RemoteViews =
    RemoteViews(context.packageName, R.layout.autofill_item).apply {
        setTextViewText(R.id.autofill_title, title)
        setTextViewText(R.id.autofill_subtitle, subtitle)
    }

@Suppress("DEPRECATION") // Dataset.Builder.setValue(id, value, presentation): the API 33 Field form needs minSdk 33
fun dataset(context: Context, form: LoginForm, title: String, username: String, password: String): Dataset {
    val view = presentation(context, title, username.ifEmpty { context.getString(R.string.no_username) })
    return Dataset.Builder(view).apply {
        form.username?.let { setValue(it, AutofillValue.forText(username), view) }
        form.password?.let { setValue(it, AutofillValue.forText(password), view) }
    }.build()
}

/** "Vaultlet…": unlock if needed and pick any login. */
@Suppress("DEPRECATION")
private fun pickerDataset(context: Context, form: LoginForm, requestId: Int): Dataset {
    val view = presentation(context, context.getString(R.string.app_name), context.getString(R.string.autofill_pick))
    val intent = Intent(context, AutofillPickActivity::class.java)
    // The system adds the screen's AssistStructure to this intent, so it must stay mutable.
    val pending = PendingIntent.getActivity(context, requestId, intent, PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_MUTABLE)
    return Dataset.Builder(view).apply {
        for (id in form.ids) setValue(id, null, view)
        setAuthentication(pending.intentSender)
    }.build()
}
