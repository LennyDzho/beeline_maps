package ru.mmi.marshrut

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File

/** Generates a real, decodable MP4 locally for the upload/playback integration test. */
fun writeTestVideo(file: File, frameIntervalUs: Long = 100000L) {
    val width = 320; val height = 240
    val format = MediaFormat.createVideoFormat("video/avc", width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        setInteger(MediaFormat.KEY_BIT_RATE, 180000); setInteger(MediaFormat.KEY_FRAME_RATE, 10); setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val codec = MediaCodec.createEncoderByType("video/avc")
    val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var started = false
    try {
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); codec.start()
        var frame = 0; var track = -1; var done = false
        val info = MediaCodec.BufferInfo(); val startedAt = System.currentTimeMillis()
        val pixels = ByteArray(width * height * 3 / 2) { if (it < width * height) 90 else 128.toByte() }
        while (!done && System.currentTimeMillis() - startedAt < 30_000) {
            if (frame <= 20) {
                val index = codec.dequeueInputBuffer(10000)
                if (index >= 0) {
                    if (frame < 20) { codec.getInputBuffer(index)!!.apply { clear(); put(pixels) }; codec.queueInputBuffer(index, 0, pixels.size, frame * frameIntervalUs, 0) }
                    else codec.queueInputBuffer(index, 0, 0, frame * frameIntervalUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    frame++
                }
            }
            val output = codec.dequeueOutputBuffer(info, 10000)
            if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = muxer.addTrack(codec.outputFormat); muxer.start(); started = true }
            else if (output >= 0) {
                if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                    val buffer = codec.getOutputBuffer(output)!!; buffer.position(info.offset); buffer.limit(info.offset + info.size)
                    muxer.writeSampleData(track, buffer, info)
                }
                done = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0; codec.releaseOutputBuffer(output, false)
            }
        }
        check(done && started) { "Video encoder did not complete" }
    } finally { codec.stop(); codec.release(); if (started) muxer.stop(); muxer.release() }
}
