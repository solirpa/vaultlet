package com.vaultlet.android.autofill

import android.app.assist.AssistStructure
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId

/** The login form found in a screen and where it belongs. */
data class LoginForm(
    val username: AutofillId?,
    val password: AutofillId?,
    /** the app showing the form */
    val packageName: String,
    /** the page's domain, only when [packageName] is a browser we trust to report it */
    val webDomain: String?,
) {
    val ids: Array<AutofillId> get() = listOfNotNull(username, password).toTypedArray()

    /** URL for site matching, or null to match by app. */
    val pageUrl: String? get() = webDomain?.let { "https://$it" }
}

/**
 * Browsers whose reported page domain we believe. Any other app can put any domain in its view
 * tree, so for those we only match by package name (`androidapp://`), or a phishing app could
 * ask for your bank's password.
 */
private val BROWSERS = setOf(
    "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
    "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
    "com.microsoft.emmx", "com.brave.browser", "com.opera.browser", "com.vivaldi.browser",
    "com.sec.android.app.sbrowser", "com.duckduckgo.mobile.android", "org.chromium.chrome",
    "com.kiwibrowser.browser", "com.UCMobile.intl", "com.tencent.mtt", "com.huawei.browser",
    "com.heytap.browser", "com.mi.globalbrowser", "com.android.browser",
)

/** System screens (lock-screen PIN, Wi-Fi passwords, ...) are not logins: never offer anything there. */
private val SYSTEM_PACKAGES = setOf(
    "android", "com.android.settings", "com.google.android.settings", "com.android.systemui",
    "com.android.permissioncontroller", "com.google.android.permissioncontroller", "com.android.packageinstaller",
)

private val USERNAME_HINTS = setOf(View.AUTOFILL_HINT_USERNAME, View.AUTOFILL_HINT_EMAIL_ADDRESS, "email", "username", "user")
private val USERNAME_WORDS = Regex("user|login|email|e-mail|account|phone|mobile|账号|用户|邮箱|手机", RegexOption.IGNORE_CASE)

fun parseLoginForm(structure: AssistStructure): LoginForm? {
    val packageName = structure.activityComponent?.packageName ?: return null
    if (packageName in SYSTEM_PACKAGES) return null
    val textFields = mutableListOf<Pair<AutofillId, Boolean>>() // (id, isPassword) in screen order
    val usernameHinted = mutableListOf<AutofillId>()
    var webDomain: String? = null

    fun visit(node: AssistStructure.ViewNode) {
        if (webDomain == null && !node.webDomain.isNullOrBlank()) webDomain = node.webDomain
        val id = node.autofillId
        if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT && node.visibility == View.VISIBLE) {
            val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
            val htmlType = node.htmlInfo?.attributes?.firstOrNull { it.first == "type" }?.second?.lowercase()
            val password = hints.any { it.contains("password") } || htmlType == "password" || isPasswordInput(node.inputType)
            textFields += id to password
            val words = listOfNotNull(node.idEntry, node.hint, node.htmlInfo?.attributes?.firstOrNull { it.first == "name" }?.second).joinToString(" ")
            if (!password && (hints.any { it in USERNAME_HINTS } || htmlType == "email" || isEmailInput(node.inputType) || USERNAME_WORDS.containsMatchIn(words))) {
                usernameHinted += id
            }
        }
        for (i in 0 until node.childCount) visit(node.getChildAt(i))
    }
    for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)

    val passwordIndex = textFields.indexOfFirst { it.second }
    val password = textFields.getOrNull(passwordIndex)?.first
    // Username: an explicitly marked field, else the text field right before the password.
    val username = usernameHinted.firstOrNull()
        ?: if (passwordIndex > 0) textFields[passwordIndex - 1].takeIf { !it.second }?.first else null
    if (password == null && username == null) return null
    val trustedDomain = webDomain?.takeIf { packageName in BROWSERS }?.trim()?.lowercase()
    return LoginForm(username, password, packageName, trustedDomain)
}

private fun isPasswordInput(inputType: Int): Boolean {
    val cls = inputType and InputType.TYPE_MASK_CLASS
    val variation = inputType and InputType.TYPE_MASK_VARIATION
    return (cls == InputType.TYPE_CLASS_TEXT && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) ||
        (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
}

private fun isEmailInput(inputType: Int): Boolean {
    val variation = inputType and InputType.TYPE_MASK_VARIATION
    return (inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT &&
        (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)
}
