# Compile a patched copy without changing Component Manager's downloaded files.
# A dependency update that invalidates the patch fails configuration visibly.
idf_component_get_property(wifi_component_dir 78__esp-wifi-connect COMPONENT_DIR)
idf_component_get_property(wifi_component_lib 78__esp-wifi-connect COMPONENT_LIB)
set(wifi_overlay_dir "${CMAKE_BINARY_DIR}/stackchan-overlays")
file(MAKE_DIRECTORY "${wifi_overlay_dir}")
execute_process(
    COMMAND patch --batch -o "${wifi_overlay_dir}/wifi_station.cc.new"
        "${wifi_component_dir}/wifi_station.cc"
        "${CMAKE_CURRENT_SOURCE_DIR}/patches/esp-wifi-connect-station.patch"
    RESULT_VARIABLE patch_status OUTPUT_QUIET ERROR_VARIABLE patch_error)
if(NOT patch_status EQUAL 0)
    message(FATAL_ERROR "StackChan Wi-Fi overlay could not be applied: ${patch_error}")
endif()
configure_file("${wifi_overlay_dir}/wifi_station.cc.new" "${wifi_overlay_dir}/wifi_station.cc" COPYONLY)
get_target_property(wifi_sources ${wifi_component_lib} SOURCES)
list(FILTER wifi_sources EXCLUDE REGEX "(^|/)wifi_station\\.cc$")
set_property(TARGET ${wifi_component_lib} PROPERTY SOURCES ${wifi_sources} "${wifi_overlay_dir}/wifi_station.cc")
target_include_directories(${wifi_component_lib} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/main/hal/utils/wifi_connect")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/patches/esp-wifi-connect-station.patch")
