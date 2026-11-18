import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

/**
 * Firebase settings for push (`Push.kt`), from the `google-services.json`
 * that `OPENAGENTD_GOOGLE_SERVICES_JSON` names. The file stays outside the
 * repository; without it the build has no push. Only the client for the
 * app's package is read.
 */
val firebase: Map<String, String> = run {
    val names = listOf("FIREBASE_APP_ID", "FIREBASE_API_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_SENDER_ID")
    val path = System.getenv("OPENAGENTD_GOOGLE_SERVICES_JSON")?.takeIf { it.isNotBlank() }
        ?: return@run names.associateWith { "" }
    val json = JsonSlurper().parse(file(path)) as Map<*, *>
    val project = json["project_info"] as Map<*, *>
    val packageName = System.getenv("OPENAGENTD_ANDROID_PACKAGE") ?: "com.openagentd.mobile"
    val client = (json["client"] as List<*>).map { it as Map<*, *> }.firstOrNull {
        val info = (it["client_info"] as Map<*, *>)["android_client_info"] as Map<*, *>
        info["package_name"] == packageName
    } ?: throw GradleException("$path has no Android app for $packageName")
    mapOf(
        "FIREBASE_APP_ID" to (client["client_info"] as Map<*, *>)["mobilesdk_app_id"].toString(),
        "FIREBASE_API_KEY" to ((client["api_key"] as List<*>).first() as Map<*, *>)["current_key"].toString(),
        "FIREBASE_PROJECT_ID" to project["project_id"].toString(),
        "FIREBASE_SENDER_ID" to project["project_number"].toString(),
    )
}

android {
    namespace = "app.openagentd.shell"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        firebase.forEach { (name, value) -> buildConfigField("String", name, "\"$value\"") }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    // Push for the account (Remote control); idle in a build without settings.
    implementation("com.google.firebase:firebase-messaging:24.1.2")
    implementation(project(":tauri-android"))
}
