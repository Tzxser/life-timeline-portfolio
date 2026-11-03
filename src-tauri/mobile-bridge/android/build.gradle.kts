import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tzxser.lifetimeline.mobile"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions { jvmTarget = JvmTarget.JVM_1_8 }
}

// This AAR contains the Android certificate verifier called through JNI. Its
// version follows Cargo.lock, including when reqwest updates its Rust dependency.
val rustlsVerifierVersion = providers.fileContents(
    layout.projectDirectory.file("../../Cargo.lock")
).asText.map { lock ->
    Regex("name = \"rustls-platform-verifier-android\"\\s+version = \"([^\"]+)\"")
        .find(lock)?.groupValues?.get(1)
        ?: error("rustls-platform-verifier-android is missing from Cargo.lock")
}

repositories {
    maven {
        url = uri("https://raw.githubusercontent.com/rustls/rustls-platform-verifier/maven-archive/android-release-support/maven/")
        content { includeGroup("org.rustls") }
    }
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("org.rustls:rustls-platform-verifier:${rustlsVerifierVersion.get()}")
}
