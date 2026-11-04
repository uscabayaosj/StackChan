cmake_minimum_required(VERSION 3.16)

project(stackchan_firmware_tests LANGUAGES CXX)

enable_testing()

add_executable(motion_math_test
    motion_math_test.cpp
    ../main/stackchan/motion/motion_math.cpp
)

target_include_directories(motion_math_test PRIVATE
    ../main
)

target_compile_features(motion_math_test PRIVATE cxx_std_17)

add_test(NAME motion_math_test COMMAND $<TARGET_FILE:motion_math_test>)

add_executable(wifi_policy_test wifi_policy_test.cpp)
target_include_directories(wifi_policy_test PRIVATE ../main)
target_compile_features(wifi_policy_test PRIVATE cxx_std_17)
add_test(NAME wifi_policy_test COMMAND $<TARGET_FILE:wifi_policy_test>)

add_executable(speech_reception_test speech_reception_test.cpp)
target_include_directories(speech_reception_test PRIVATE ../main)
target_compile_features(speech_reception_test PRIVATE cxx_std_17)
add_test(NAME speech_reception_test COMMAND $<TARGET_FILE:speech_reception_test>)
