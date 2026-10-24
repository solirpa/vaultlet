package com.vaultlet.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.ripple
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vaultlet.android.R

/**
 * The desktop app's tonal design system (apps/desktop/src/styles.css): hierarchy from surface
 * levels rather than outlines, one accent, hairlines only where tone is not enough.
 */
@Immutable
data class Palette(
    val bg: Color,
    val surface: Color,
    val surface2: Color,
    val surface3: Color,
    val text: Color,
    val muted: Color,
    val faint: Color,
    val accent: Color,
    val accentSoft: Color,
    val danger: Color,
    val success: Color,
    val warning: Color,
    val hairline: Color,
    val toast: Color,
    val dark: Boolean,
)

val LightPalette = Palette(
    bg = Color(0xFFF5F5F7), surface = Color(0xFFFFFFFF), surface2 = Color(0xFFF1F1F4), surface3 = Color(0xFFE8E8EC),
    text = Color(0xFF1D1D1F), muted = Color(0xFF6E6E73), faint = Color(0xFFA1A1A6),
    accent = Color(0xFF2F6BFF), accentSoft = Color(0x1F2F6BFF), danger = Color(0xFFD93A32), success = Color(0xFF1E9E57),
    warning = Color(0xFFC9870A), hairline = Color(0x0F000000), toast = Color(0xFF1D1D1F), dark = false,
)

val DarkPalette = Palette(
    bg = Color(0xFF1C1C1E), surface = Color(0xFF232327), surface2 = Color(0xFF2C2C31), surface3 = Color(0xFF36363C),
    text = Color(0xFFF5F5F7), muted = Color(0xFFA0A0A6), faint = Color(0xFF6E6E75),
    accent = Color(0xFF5B8CFF), accentSoft = Color(0x335B8CFF), danger = Color(0xFFFF6B63), success = Color(0xFF41C278),
    warning = Color(0xFFE8AD3A), hairline = Color(0x14FFFFFF), toast = Color(0xFF3A3A40), dark = true,
)

val LocalPalette = staticCompositionLocalOf { LightPalette }

/** Shorthand: `P.accent`. */
val P: Palette @Composable get() = LocalPalette.current

@Composable
fun VaultletTheme(content: @Composable () -> Unit) {
    val p = if (isSystemInDarkTheme()) DarkPalette else LightPalette
    // Material components (dialogs, sliders, progress) pick up the same tokens.
    val scheme = (if (p.dark) darkColorScheme() else lightColorScheme()).copy(
        primary = p.accent, onPrimary = Color.White, primaryContainer = p.accentSoft, onPrimaryContainer = p.accent,
        secondary = p.accent, secondaryContainer = p.accentSoft, onSecondaryContainer = p.accent, tertiary = p.warning,
        background = p.bg, onBackground = p.text, surface = p.surface, onSurface = p.text, onSurfaceVariant = p.muted,
        surfaceContainer = p.surface, surfaceContainerHigh = p.surface, surfaceContainerHighest = p.surface2,
        surfaceContainerLow = p.surface, surfaceContainerLowest = p.surface, surfaceVariant = p.surface2,
        outline = p.faint, outlineVariant = p.hairline, error = p.danger,
    )
    CompositionLocalProvider(LocalPalette provides p) {
        MaterialTheme(colorScheme = scheme) {
            // testTagsAsResourceId: UI tests (uiautomator / adb) find elements by their test tags.
            Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }, color = p.bg, contentColor = p.text, content = content)
        }
    }
}

// ---- type -------------------------------------------------------------------------------------

object Type {
    val largeTitle = TextStyle(fontSize = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
    val title = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp)
    val headline = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
    val body = TextStyle(fontSize = 16.sp, lineHeight = 22.sp)
    val callout = TextStyle(fontSize = 15.sp, lineHeight = 20.sp)
    val subhead = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp)
    val section = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.2.sp)
    val mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 15.sp)
}

// ---- brand ------------------------------------------------------------------------------------

/** The desktop logo: accent gradient tile with a key (same geometry as AuthShell's VaultLogo). */
@Composable
fun VaultLogo(size: Dp = 64.dp) {
    val accent = P.accent
    Box(
        Modifier
            .size(size)
            .shadow(14.dp, RoundedCornerShape(size * 0.28f), ambientColor = accent, spotColor = accent)
            .background(
                Brush.linearGradient(listOf(lerpColor(accent, Color.White, 0.2f), accent, lerpColor(accent, Color.Black, 0.2f))),
                RoundedCornerShape(size * 0.28f),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(size * 0.52f)) {
            val u = this.size.width / 24f
            val stroke = Stroke(width = 2.6f * u, cap = StrokeCap.Round)
            drawCircle(Color.White, radius = 4.6f * u, center = Offset(9 * u, 9 * u), style = stroke)
            drawLine(Color.White, Offset(12.3f * u, 12.3f * u), Offset(19.5f * u, 19.5f * u), 2.6f * u, StrokeCap.Round)
            drawLine(Color.White, Offset(16.4f * u, 16.4f * u), Offset(14.4f * u, 18.4f * u), 2.6f * u, StrokeCap.Round)
            drawLine(Color.White, Offset(19f * u, 19f * u), Offset(17f * u, 21f * u), 2.6f * u, StrokeCap.Round)
        }
    }
}

private fun lerpColor(a: Color, b: Color, t: Float) = Color(
    red = a.red + (b.red - a.red) * t, green = a.green + (b.green - a.green) * t,
    blue = a.blue + (b.blue - a.blue) * t, alpha = 1f,
)

/** FNV-1a, same as the desktop's `hash()`, so an item gets the same colour everywhere. */
private fun hash(s: String): Long {
    var h = 0x811c9dc5L
    for (c in s) {
        h = h xor c.code.toLong()
        h = (h * 0x01000193L) and 0xffffffffL
    }
    return h
}

/** Gradient monogram tile (desktop `.monogram`): hue from the title. */
@Composable
fun Monogram(title: String, size: Dp = 40.dp, icon: ImageVector? = null) {
    val hue = (hash(title.trim().lowercase().ifEmpty { "?" }) % 360).toFloat()
    val top = if (P.dark) Color.hsl(hue, 0.52f, 0.50f) else Color.hsl(hue, 0.72f, 0.64f)
    val bottom = if (P.dark) Color.hsl(hue, 0.50f, 0.40f) else Color.hsl(hue, 0.64f, 0.50f)
    Box(
        Modifier.size(size).clip(RoundedCornerShape(size * 0.26f)).background(Brush.verticalGradient(listOf(top, bottom))),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = Color.White, modifier = Modifier.size(size * 0.5f))
        } else {
            Text(
                title.trim().take(1).uppercase().ifEmpty { "?" },
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.44f).sp,
            )
        }
    }
}

// ---- grouped blocks ---------------------------------------------------------------------------

@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(P.surface), content = content)
}

@Composable
fun GroupDivider(inset: Dp = 16.dp) {
    Box(Modifier.padding(start = inset).fillMaxWidth().height(0.5.dp).background(P.hairline))
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: String? = null) {
    Row(modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 22.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = Type.section, color = P.muted, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, style = Type.caption, color = P.faint)
    }
}

/** A row inside a [Group]: label above value, trailing actions. */
@Composable
fun FieldRow(
    label: String,
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit = {},
    value: @Composable () -> Unit,
) {
    Row(modifier.fillMaxWidth().heightIn(min = 60.dp).padding(start = 16.dp, end = 6.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = Type.caption, color = P.muted)
            Box(Modifier.padding(top = 2.dp)) { value() }
        }
        trailing()
    }
}

@Composable
fun IconAction(icon: ImageVector, description: String, modifier: Modifier = Modifier, tint: Color = P.muted, onClick: () -> Unit) {
    Box(
        modifier
            .size(40.dp)
            .clip(CircleShape)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = ripple(bounded = true), onClick = onClick)
            .semantics { this.contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

// ---- inputs & buttons -------------------------------------------------------------------------

/** Filled field on surface-2, label above (desktop `.input`). */
@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    label: String?,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    secret: Boolean = false,
    mono: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    keyboardType: KeyboardType = KeyboardType.Text,
    onDone: (() -> Unit)? = null,
    /** test tag on the text input itself */
    tag: String? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    var visible by remember { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
        if (label != null) Text(label, style = Type.subhead, color = P.muted, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        Row(
            Modifier.fillMaxWidth().heightIn(min = 50.dp).clip(RoundedCornerShape(12.dp)).background(P.surface2).padding(start = 14.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = singleLine,
                minLines = minLines,
                textStyle = (if (mono) Type.mono else Type.body).copy(color = P.text),
                cursorBrush = SolidColor(P.accent),
                visualTransformation = if (secret && !visible) PasswordVisualTransformation() else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else keyboardType),
                keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
                modifier = Modifier.weight(1f).padding(vertical = 14.dp)
                    .let { if (tag != null) it.testTag(tag) else it }
                    .let { if (label != null) it.semantics { contentDescription = label } else it },
                decorationBox = { inner ->
                    Box {
                        if (value.isEmpty() && placeholder != null) Text(placeholder, style = if (mono) Type.mono else Type.body, color = P.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                },
            )
            if (secret) {
                IconAction(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, stringResource(if (visible) R.string.hide else R.string.show)) { visible = !visible }
            }
            trailing()
        }
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, busy: Boolean = false, icon: ImageVector? = null) {
    val on = enabled && !busy
    Row(
        modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (on || busy) P.accent else P.surface3)
            .clickable(enabled = on, onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
        } else {
            if (icon != null) Icon(icon, null, tint = if (on) Color.White else P.faint, modifier = Modifier.padding(end = 8.dp).size(20.dp))
            Text(text, style = Type.headline, color = if (on) Color.White else P.faint)
        }
    }
}

@Composable
fun TonalButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, color: Color = P.accent) {
    Row(
        modifier.height(50.dp).clip(RoundedCornerShape(14.dp)).background(color.copy(alpha = if (P.dark) 0.2f else 0.1f)).clickable(onClick = onClick).padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = color, modifier = Modifier.padding(end = 8.dp).size(20.dp))
        Text(text, style = Type.headline, color = color)
    }
}

/** Small accent pill (desktop toolbar "+ New" / "Edit"). */
@Composable
fun Pill(text: String, icon: ImageVector?, onClick: () -> Unit, modifier: Modifier = Modifier, filled: Boolean = false) {
    Row(
        modifier.height(36.dp).clip(CircleShape).background(if (filled) P.accent else P.accentSoft).clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = if (filled) Color.White else P.accent, modifier = Modifier.padding(end = 6.dp).size(18.dp))
        Text(text, style = Type.subhead.copy(fontWeight = FontWeight.SemiBold), color = if (filled) Color.White else P.accent)
    }
}

// ---- TOTP -------------------------------------------------------------------------------------

/** Countdown ring next to the code (desktop TotpRing); red in the last 5 seconds. */
@Composable
fun TotpRing(remaining: Int, period: Int, modifier: Modifier = Modifier) {
    val urgent = remaining <= 5
    val track = P.surface3
    val color = if (urgent) P.danger else P.accent
    Box(modifier.size(28.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(22.dp)) {
            val w = 2.4.dp.toPx()
            drawCircle(track, style = Stroke(w))
            drawArc(color, -90f, 360f * remaining / period.coerceAtLeast(1), false, style = Stroke(w, cap = StrokeCap.Round))
        }
        Text("$remaining", style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.SemiBold), color = color)
    }
}

/** Dark pill toast (desktop toast), shown over the bottom of the screen. */
@Composable
fun Toast(text: String, modifier: Modifier = Modifier) {
    Box(modifier.clip(RoundedCornerShape(12.dp)).background(P.toast).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Text(text, style = Type.subhead, color = Color.White)
    }
}

fun Modifier.tag(tag: String) = this.testTag(tag)
