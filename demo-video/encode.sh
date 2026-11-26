#!/bin/bash
# usage: encode.sh take out.mp4
set -e
D="$(dirname "$0")/$1_frames"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$D/list.txt" -f lavfi -i anullsrc=r=48000:cl=stereo \
  -vf "tpad=stop_mode=clone:stop_duration=${PAD:-0},fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libx264 -preset slow -crf 19 -profile:v high -level 4.1 \
  -c:a aac -b:a 64k -shortest -movflags +faststart "$2"
ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$2"
