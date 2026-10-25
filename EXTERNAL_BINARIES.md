# 外部二進位檔（不放進 git）

這個 repo **不追蹤**體積大的二進位檔。請依下表自行取得，放回相同路徑。版本資訊取自作者本機的實際檔案。

| 路徑 | 大小 | 版本／內容 | 取得方式 |
|---|---|---|---|
| `Lavalink.jar` | 100.6 MB | Lavalink 4.2.2 | Lavalink 官方 Releases：https://github.com/lavalink-devs/Lavalink/releases（下載對應版本的 Lavalink.jar） |
| `workspace/tools/ffmpeg/LICENSE.txt` | 0.0 MB | 二進位檔 | 見專案說明 |
| `workspace/tools/ffmpeg/bin/avcodec-62.dll` | 97.7 MB | FFmpeg 共享函式庫（avcodec-62.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/avdevice-62.dll` | 3.7 MB | FFmpeg 共享函式庫（avdevice-62.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/avfilter-11.dll` | 94.7 MB | FFmpeg 共享函式庫（avfilter-11.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/avformat-62.dll` | 22.1 MB | FFmpeg 共享函式庫（avformat-62.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/avutil-60.dll` | 2.9 MB | FFmpeg 共享函式庫（avutil-60.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/ffmpeg.exe` | 0.5 MB | 二進位檔 | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/ffprobe.exe` | 0.2 MB | 二進位檔 | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/swresample-6.dll` | 0.7 MB | FFmpeg 共享函式庫（swresample-6.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/bin/swscale-9.dll` | 12.6 MB | FFmpeg 共享函式庫（swscale-9.dll） | FFmpeg Windows 共享建置（含 bin/*.dll）：https://www.gyan.dev/ffmpeg/builds/ 或 https://github.com/BtbN/FFmpeg-Builds/releases ，解壓後放到 workspace/tools/ffmpeg/ |
| `workspace/tools/ffmpeg/presets/libvpx-1080p.ffpreset` | 0.0 MB | 二進位檔 | 見專案說明 |
| `workspace/tools/ffmpeg/presets/libvpx-1080p50_60.ffpreset` | 0.0 MB | 二進位檔 | 見專案說明 |
| `workspace/tools/ffmpeg/presets/libvpx-360p.ffpreset` | 0.0 MB | 二進位檔 | 見專案說明 |
| `workspace/tools/ffmpeg/presets/libvpx-720p.ffpreset` | 0.0 MB | 二進位檔 | 見專案說明 |
| `workspace/tools/ffmpeg/presets/libvpx-720p50_60.ffpreset` | 0.0 MB | 二進位檔 | 見專案說明 |

## 說明

- `workspace/tools/ffmpeg/`：FFmpeg 的 `bin/` 目錄（avcodec-62.dll, avdevice-62.dll, avfilter-11.dll, avformat-62.dll, avutil-60.dll, swresample-6.dll, swscale-9.dll）。本機 ffmpeg 版本：`ffmpeg version N-124387-gaa14727cd5-20260504 Copyright (c) 2000-2026 the FFmpeg developers`。
- `Lavalink.jar`：音樂播放用的 Lavalink 伺服器，設定檔為 `application.yml`（若該檔被排除，請複製 `application.example.yml` 為 `application.yml` 並自行設定密碼）。
- 這些檔案已寫進 `.gitignore`（`*.jar`、`*.dll`、`*.exe`、`workspace/tools/ffmpeg/`），不會被再次加入。
- 憑證類檔案（`openclaw.json`、`identity/`、`devices/`、各種 `.env`）同樣不在 repo 內，請在本機自行建立。
