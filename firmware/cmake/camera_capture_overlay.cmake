# Keep the camera frame wait finite even when the sensor stops providing frames.
idf_component_get_property(video_component_dir espressif__esp_video COMPONENT_DIR)
idf_component_get_property(video_component_lib espressif__esp_video COMPONENT_LIB)
set(video_overlay_dir "${CMAKE_BINARY_DIR}/stackchan-overlays")
file(MAKE_DIRECTORY "${video_overlay_dir}")
set(video_patch "${CMAKE_CURRENT_SOURCE_DIR}/patches/esp-video-capture-timeout.patch")
execute_process(
    COMMAND patch --batch -o "${video_overlay_dir}/esp_video_ioctl.c.new"
        "${video_component_dir}/src/esp_video_ioctl.c" "${video_patch}"
    RESULT_VARIABLE patch_status OUTPUT_QUIET ERROR_VARIABLE patch_error)
if(NOT patch_status EQUAL 0)
    message(FATAL_ERROR "StackChan camera timeout patch could not be applied: ${patch_error}")
endif()
configure_file("${video_overlay_dir}/esp_video_ioctl.c.new" "${video_overlay_dir}/esp_video_ioctl.c" COPYONLY)
get_target_property(video_sources ${video_component_lib} SOURCES)
list(FILTER video_sources EXCLUDE REGEX "(^|/)esp_video_ioctl\\.c$")
set_property(TARGET ${video_component_lib} PROPERTY SOURCES ${video_sources} "${video_overlay_dir}/esp_video_ioctl.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${video_patch}")
