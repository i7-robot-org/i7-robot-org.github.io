# i7 导航取水 Demo 影片 · brief

这份 brief 记录影片的结构和制作方法，也可以当作提示词复用（换场景、换任务时改 `<inputs>` 和 `<structure>
0–4s       片头：机器人站在接令位置，镜头缓慢环绕；左侧标题“导航取水”
4–12s      建图：俯视全场，机器人绕实验室一圈，激光射线扫出占据栅格地图
12–14.5s   定位：地图变淡，定位脉冲，“定位正常 · Localized”
14.5–19s   接令：工程师坐在北排办公桌前打字，13.7s 起转椅转身、14.45s 起身，对东侧的机器人说“i7，帮我拿杯水”，机器人回答“好的，马上去拿”，记下返回点
19–24.5s   识别：机器人原地转身环顾，右上角头部相机画中画给办公桌、抽屉桌、水瓶画检测框；22.3s 锁定抽屉桌（3D 蓝框 +“抽屉桌 · 有水瓶”），23.2s 在桌前给出导航目标
24.5–31s   导航：蓝色路径画出，跟随镜头看机器人走到抽屉桌前的目标点，停下时与桌面约有 11° 偏角
31–36.5s   对正：画中画换成深度图并标出拟合的桌子前侧平面（3D 中橙色面），地面画出目标位姿框；左上读数面板显示偏角和距离，机器人原地转正、再前移到抓取距离，读数归零后显示“已正对，可以抓取”
36.5–45.5s 抓取：升降下调，右臂经预抓取位平移靠近水瓶；38.5–42.3s 特写夹爪张开、合拢夹紧、抬起，再拉回中景收臂；右上角头部相机画中画
45.5–53.5s 返回：后退、转向，沿路径绕回返回点，镜头从东侧跟随看到手里的水
53.5–61.5s 递交：机器人说“水来了，请拿好”并伸臂递出，人伸手拉；左上角力矩曲线越过阈值，56.9–58.8s 特写夹爪松开，人说“谢谢！”
61.5–65.5s 片尾：镜头升起，白色蒙版上出现“一句话，把水递到你手里。”
</structure>

<build>
1. 画面：Three.js r160（Z 轴向上），机器人网格由厂商 STL 减面后转成 JSON；IK 用阻尼最小二乘数值解。
2. assets/i7sim.js 暴露 render(t)，画面只由 t 决定；film.html 全屏调用它，网站的交互仿真也复用同一个模块。
3. 渲染：video/render.mjs 用 Playwright 逐帧调用 render(t) 截图，ffmpeg 合成 MP4，可多进程分段并行。
4. 声音：video/make_voice.py 用 Kokoro（sherpa-onnx）合成四句对白到 video/voice/；video/make_audio.py 按同一时间表合成配乐和音效，混入对白（说话时音乐压低），ffmpeg loudnorm 归一到 -14 LUFS、峰值 -1.5 dBTP。
5. 每个镜头先出静帧自查：文字溢出、标签和顶部步骤条重叠、主体大小、字幕可读性。
</build>

<gotchas>
- 字体按 unicode-range 分片加载：film.html 先用 document.fonts.load 把所有字幕文字需要的字形加载完，再置 window.ready。
- 机器人 base_link 原点在底盘前沿，转向中心在其后约 0.26 m。
- 高度：升降到顶时整机约 1.76 m（含轮子），取景要给头顶的气泡留空间；屏幕上的标签不能高于顶部步骤条。
- 配色：assets/paint_mesh.py 把每个连杆拆成独立零件，按位置分配材质；头部外壳减面后会皱，由 i7sim.js 用圆角盒重建。
- 对白时间改动时，make_voice.py 的 LINES、i7sim.js 的 VOICE 和气泡时间要一起改。
- 软件渲染（SwiftShader）下 1080p 约 2.4 秒一帧，整片单进程约 70 分钟。
</gotchas>

<start>
按章节顺序搭镜头，每章出静帧检查；全部完成后渲染整片，出抽帧图验收，再交付。
</start>
```

## 重新渲染

```bash
cd docs/showcase/video
node render.mjs --out i7_demo_raw.mp4 --workers 4            # 画面（需 Playwright + Chromium、ffmpeg），默认 65.5 秒
python3 make_voice.py <kokoro 模型目录>                       # 对白（只在台词改动时需要）
python3 make_audio.py raw.wav && ffmpeg -i raw.wav -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 48000 mix.wav
ffmpeg -i i7_demo_raw.mp4 -i mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart i7_demo.mp4
node render.mjs --still 58.1 --clean --out poster.jpg         # 单帧；--query studio=-0.65 出机器人白底图；--query cam=x,y,z,tx,ty,tz 换固定机位检查
```

无法访问 cdn.jsdelivr.net 时，设置 `THREE_DIR=<本地 node_modules/three>`；需要代理加载网页字体时设置 `BROWSER_PROXY`。
