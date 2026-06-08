#pragma once
#define atomic_bool _Atomic _Bool
#define atomic_int _Atomic int
#define atomic_uint _Atomic unsigned int
#define atomic_long _Atomic long
#define atomic_ulong _Atomic unsigned long
#define atomic_load(obj) (*(obj))
#define atomic_store(obj, value) (*(obj) = (value))

