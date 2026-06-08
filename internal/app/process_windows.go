//go:build windows

package app

import (
	"context"
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	jobObjectExtendedLimitInformationClass = 9
	jobObjectLimitKillOnJobClose           = 0x00002000
	processSetQuota                        = 0x0100
	processTerminate                       = 0x0001
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW   = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJob  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob = kernel32.NewProc("AssignProcessToJobObject")
	procCloseHandle        = kernel32.NewProc("CloseHandle")
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func runCommand(ctx context.Context, cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}

	job := createKillOnCloseJob()
	if job == 0 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return fmt.Errorf("failed to create Windows job object")
	}
	if err := assignProcessToJob(job, cmd.Process.Pid); err != nil {
		closeHandle(job)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		closeHandle(job)
		return err
	case <-ctx.Done():
		closeHandle(job)
		_ = cmd.Process.Kill()
		<-done
		return ctx.Err()
	}
}

func createKillOnCloseJob() syscall.Handle {
	handle, _, _ := procCreateJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0
	}
	info := jobObjectExtendedLimitInformation{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, _ := procSetInformationJob.Call(
		handle,
		uintptr(jobObjectExtendedLimitInformationClass),
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Sizeof(info)),
	)
	if ok == 0 {
		closeHandle(syscall.Handle(handle))
		return 0
	}
	return syscall.Handle(handle)
}

func assignProcessToJob(job syscall.Handle, pid int) error {
	process, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)
	ok, _, callErr := procAssignProcessToJob.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		if callErr != syscall.Errno(0) {
			return callErr
		}
		return fmt.Errorf("AssignProcessToJobObject failed")
	}
	return nil
}

func closeHandle(handle syscall.Handle) {
	procCloseHandle.Call(uintptr(handle))
}
