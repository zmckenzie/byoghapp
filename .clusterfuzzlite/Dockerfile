# ClusterFuzzLite build image. The base image is pinned by digest; Dependabot
# (docker ecosystem, /.clusterfuzzlite) keeps it current.
FROM gcr.io/oss-fuzz-base/base-builder-javascript:ubuntu-24-04@sha256:c864b45fd1d0daf0a6716939fcb847dac41859e326f059b4f0ffc6e727fe6556
COPY . $SRC/byoghapp
WORKDIR $SRC/byoghapp
COPY .clusterfuzzlite/build.sh $SRC/
